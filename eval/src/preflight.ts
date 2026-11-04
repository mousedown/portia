import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Arm, ArmContext } from "./arms";
import { claudeSession, type Exec, spawnExec } from "./arms/claude";
import { portiaEnv } from "./arms/portia";
import { findEpic, type LoadedSuite, loadTickets } from "./suite";

export interface PreflightCheck {
	name: string;
	ok: boolean;
	detail: string;
}

/** The whole of the session a preflight spends: a one-word reply, capped. */
export const PREFLIGHT_USD = 0.05;
const PREFLIGHT_MINUTES = 3;

/**
 * Everything a paid run depends on, short of the run: the tickets, a fresh clone set up, the
 * login a clean session uses (one capped one-word session on the pinned model), and for
 * Portia its profile, a push to the real remote (dry run) and the epic read from the
 * tracker. Nothing is written to the results or the ledger, so a failed setup costs cents,
 * not a run.
 */
export async function preflight(o: {
	suite: LoadedSuite;
	arm: Arm;
	epicKey: string;
	root: string;
	exec?: Exec;
	env?: Record<string, string | undefined>;
}): Promise<PreflightCheck[]> {
	const exec = o.exec ?? spawnExec;
	const env = o.env ?? process.env;
	const checks: PreflightCheck[] = [];
	const check = async (name: string, f: () => Promise<string>) => {
		try {
			checks.push({ name, ok: true, detail: await f() });
			return true;
		} catch (e) {
			checks.push({ name, ok: false, detail: (e as Error).message });
			return false;
		}
	};
	const run = async (cmd: string[], cwd: string, extra = {}) => {
		const r = await exec(cmd, {
			cwd,
			env: { ...(env as Record<string, string>), ...extra },
		});
		if (r.exitCode)
			throw new Error(
				`${cmd.join(" ")} exited ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-400)}`,
			);
		return r.stdout;
	};

	const { repo, epic } = findEpic(o.suite, o.epicKey);
	const work = mkdtempSync(join(tmpdir(), "eval-preflight-"));
	const clone = join(work, "clone");
	const artifacts = join(work, "artifacts");
	mkdirSync(artifacts, { recursive: true });
	let tickets: ArmContext["tickets"] | undefined;

	if (
		!(await check("tickets", async () => {
			tickets = loadTickets(o.suite, epic);
			return `${epic.key} and ${Object.keys(tickets.children).length} children`;
		}))
	)
		return checks;
	if (
		!(await check("clone and setup", async () => {
			await run(
				["git", "clone", "--quiet", resolve(o.root, repo.source), clone],
				o.root,
			);
			await run(["git", "checkout", "--quiet", repo.main], clone);
			if (repo.setup) await run(["sh", "-c", repo.setup], clone);
			return `${repo.name} on ${repo.main}`;
		}))
	)
		return checks;

	const ctx: ArmContext = {
		clone,
		repo,
		epic,
		tickets: tickets as ArmContext["tickets"],
		artifacts,
		limits: o.suite.limits,
		model: o.suite.model,
		person: join(o.suite.dir, "person.json"),
		exec,
		log: () => {},
	};

	let portia: Record<string, string> | undefined;
	if (o.arm.name === "portia") {
		await check("portia profile", async () => {
			portia = portiaEnv(
				join(artifacts, "portia-home"),
				ctx.person,
				repo.name,
				env,
			);
			return portia.PORTIA_PROFILE as string;
		});
		await check("push to the tracker's repo", async () => {
			if (!repo.remote)
				throw new Error(`suite repo ${repo.name} has no remote`);
			await run(["git", "remote", "set-url", "origin", repo.remote], clone);
			await run(
				[
					"git",
					"push",
					"--dry-run",
					"origin",
					`HEAD:refs/heads/preflight/${epic.key}`,
				],
				clone,
			);
			return repo.remote;
		});
		if (portia)
			await check("epic read from the tracker", async () => {
				const out = join(artifacts, "plan-context.json");
				await run(
					["portia", "plan", "context", epic.key, "--out", out],
					clone,
					portia,
				);
				const got = (
					JSON.parse(readFileSync(out, "utf8")).children as { key: string }[]
				)
					.map((c) => c.key)
					.sort();
				const want = epic.children.map((c) => c.key).sort();
				if (got.join() !== want.join())
					throw new Error(
						`the tracker has ${got.join(", ") || "no children"}, the suite ${want.join(", ")}`,
					);
				return `${epic.key}: ${got.join(", ")}`;
			});
	}

	if (!o.arm.free)
		await check("login", async () => {
			if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY)
				throw new Error(
					"no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY: a clean session has no stored login",
				);
			const s = await claudeSession(ctx, {
				cwd: clone,
				prompt: "Reply with the single word OK and nothing else.",
				name: "preflight",
				usd: PREFLIGHT_USD,
				minutes: PREFLIGHT_MINUTES,
			});
			if (s.exitCode || !/\bOK\b/.test(s.result))
				throw new Error(
					`session ${s.stoppedBy ?? `exited ${s.exitCode}`}: ${s.result.trim().slice(0, 200) || "no reply"}`,
				);
			const models = Object.keys(s.tokensByModel).join(", ") || o.suite.model;
			return `${models}, ${s.tokens} tokens${s.usd !== undefined ? `, $${s.usd.toFixed(4)}` : ""}`;
		});

	return checks;
}
