import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmContext } from "../src/arms";
import {
	BERNSTEIN_VERSION,
	bernstein,
	bernsteinCommand,
} from "../src/arms/bernstein";
import {
	answeredSession,
	asksThePerson,
	claudeCommand,
	type Exec,
	epicBrief,
	reviewedSession,
	ticket,
	unscripted,
} from "../src/arms/claude";
import {
	claudeOrchestrated,
	INVITATION,
} from "../src/arms/claude-orchestrated";
import { childBrief, claudeParallel } from "../src/arms/claude-parallel";
import { claudeSerial } from "../src/arms/claude-serial";
import {
	claudeWorkflow,
	gateSettings,
	WORKFLOW,
	workflowArgs,
	workflowPrompt,
} from "../src/arms/claude-workflow";
import { portia, scoredBranch, workersUsd } from "../src/arms/portia";
import { git } from "../src/metrics/git";
import { ARMS } from "../src/run";
import { findEpic, hiddenDir, loadSuite, loadTickets } from "../src/suite";

/**
 * Runs the suite's frozen `workflow.js` as Claude Code would, with a fake `agent` that
 * records every prompt and answers it, and returns the prompts in the order they were sent.
 */
async function runWorkflowScript(ctx: ArmContext, branch: string) {
	const source = readFileSync(
		join(import.meta.dir, "../suites/v1/workflow.js"),
		"utf8",
	);
	expect(source.startsWith("export const meta = {")).toBe(true);
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	const body = source.replace(/^export const meta/, "const meta");
	const run = new AsyncFunction(
		"args",
		"agent",
		"parallel",
		"phase",
		"log",
		body,
	);
	const agents: { prompt: string; opts: Record<string, unknown> }[] = [];
	await run(
		JSON.stringify(workflowArgs(ctx, branch)),
		async (prompt: string, opts: Record<string, unknown>) => {
			agents.push({ prompt, opts });
			return opts.schema
				? { branch: `${branch}/${opts.label}`, done: true, scenarios: ["R1"] }
				: "merged";
		},
		(thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t())),
		() => {},
		() => {},
	);
	return agents;
}

// No arm here starts Claude Code: a fake exec records every command and answers it, so the
// tests read the command line, environment and config each session would have had.
interface Call {
	cmd: string[];
	cwd: string;
	env: Record<string, string>;
	stdin?: string;
}

const result = (o: {
	id: string;
	tokens: number;
	usd: number;
	text?: string;
}) =>
	JSON.stringify({
		type: "result",
		subtype: "success",
		result: o.text ?? "done",
		session_id: o.id,
		total_cost_usd: o.usd,
		usage: { input_tokens: o.tokens },
		modelUsage: { "claude-sonnet": { inputTokens: o.tokens } },
	});

/** Sessions answer in turn; each check run takes the next exit code (0 once they run out). */
function fakeExec(o: {
	sessions?: { tokens: number; usd: number; text?: string }[];
	checks?: number[];
}): { exec: Exec; calls: Call[] } {
	const calls: Call[] = [];
	let n = 0;
	let c = 0;
	const exec: Exec = async (cmd, x) => {
		calls.push({ cmd, cwd: x.cwd, env: x.env, stdin: x.stdin });
		if (cmd[0] === "claude") {
			const s = o.sessions?.[n] ?? { tokens: 100, usd: 1 };
			n++;
			return { exitCode: 0, stdout: result({ id: `s${n}`, ...s }), stderr: "" };
		}
		const code = o.checks?.[c++] ?? 0;
		return {
			exitCode: code,
			stdout: code ? "1 test failed" : "ok",
			stderr: "",
		};
	};
	return { exec, calls };
}

const claudeCalls = (calls: Call[]) =>
	calls.filter((c) => c.cmd[0] === "claude");
const flag = (cmd: string[], name: string) => cmd[cmd.indexOf(name) + 1];

let dir: string;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "eval-arms-"));
	const clone = join(dir, "clone");
	mkdirSync(clone);
	await git(clone, ["init", "-q", "-b", "main"]);
	await git(clone, [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	]);
	mkdirSync(join(dir, "artifacts"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function context(exec: Exec, limits: Partial<ArmContext["limits"]> = {}) {
	const ctx: ArmContext = {
		clone: join(dir, "clone"),
		repo: {
			name: "acme-shop",
			source: "x",
			main: "main",
			test: "bun test {file}",
			checks: ["bun run lint", "bun test"],
			epics: [],
		},
		epic: {
			key: "ACME-500",
			title: "Rocket delivery",
			tracker: "github",
			hidden: "hidden/ACME-500",
			expect: "delivered",
			scenarios: [{ id: "R1", text: "a crate is listed" }],
			children: [{ key: "ACME-501", touches: ["src/delivery/**"] }],
		},
		tickets: {
			epic: "# Rocket delivery\n\nThe epic's body.\n",
			children: {
				"ACME-501": "# Manifest a crate\n\nThe manifest ticket's body.\n",
				"ACME-502": "# Price a delivery\n\nThe pricing ticket's body.\n",
			},
		},
		artifacts: join(dir, "artifacts"),
		limits: { usd: 40, minutes: 180, reviews: 3, ...limits },
		model: "sonnet",
		person: join(dir, "person.json"),
		exec,
		log: () => {},
	};
	return ctx;
}

describe("claudeCommand", () => {
	it("pins the suite's model, allows the shell and caps the spend", () => {
		const { cmd, env } = claudeCommand(context(fakeExec({}).exec), {});
		// Background work (a Portia land, a workflow) is waited for, not cut off at ten minutes.
		expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe("0");
		expect(flag(cmd, "--model")).toBe("sonnet");
		expect(flag(cmd, "--permission-mode")).toBe("acceptEdits");
		expect(flag(cmd, "--allowedTools")).toBe("Bash");
		expect(cmd).toContain("--strict-mcp-config");
		expect(flag(cmd, "--max-budget-usd")).toBe("40.00");
	});

	it("runs in a fresh config directory inside the run, with no user skills", () => {
		const ctx = context(fakeExec({}).exec);
		const { env, configDir } = claudeCommand(ctx, {});
		expect(configDir).toBe(join(ctx.artifacts, "claude-config"));
		expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
		expect(readdirSync(configDir)).toEqual(["skills"]);
		expect(readdirSync(join(configDir, "skills"))).toEqual([]);
	});

	it("keeps only the operator environment a session needs", () => {
		process.env.ANTHROPIC_MODEL = "claude-opus";
		process.env.PORTIA_PROFILE = "/somewhere";
		try {
			const { env } = claudeCommand(context(fakeExec({}).exec), {});
			expect(env.PATH).toBe(process.env.PATH as string);
			expect(env.ANTHROPIC_MODEL).toBeUndefined();
			expect(env.PORTIA_PROFILE).toBeUndefined();
		} finally {
			delete process.env.ANTHROPIC_MODEL;
			delete process.env.PORTIA_PROFILE;
		}
	});
});

describe("claude-serial", () => {
	it("is sent back while the repo's checks fail, and each round is rework", async () => {
		// Round 1: lint passes, tests fail. Round 2: both pass.
		const { exec, calls } = fakeExec({
			sessions: [
				{ tokens: 300, usd: 3 },
				{ tokens: 100, usd: 1 },
			],
			checks: [0, 1, 0, 0],
		});
		const ctx = context(exec);
		const out = await claudeSerial.run(ctx);
		const sessions = claudeCalls(calls);
		expect(sessions).toHaveLength(2);
		expect(sessions[0]?.stdin).toBe(epicBrief(ctx));
		expect(sessions[0]?.cmd).not.toContain("--resume");
		expect(flag(sessions[1]?.cmd ?? [], "--resume")).toBe("s1");
		expect(sessions[1]?.stdin).toContain("$ bun test\n1 test failed");
		// What is left of the cap after round 1.
		expect(flag(sessions[1]?.cmd ?? [], "--max-budget-usd")).toBe("37.00");
		for (const s of sessions) expect(flag(s.cmd, "--model")).toBe("sonnet");

		// The reviewer ran the repo's checks in the clone, and nothing else.
		const checks = calls.filter((c) => c.cmd[0] === "sh");
		expect(checks.map((c) => c.cmd[2])).toEqual([
			"bun run lint",
			"bun test",
			"bun run lint",
			"bun test",
		]);
		for (const c of checks) expect(c.cwd).toBe(ctx.clone);

		expect(out.branch).toBe("eval/ACME-500/claude-serial");
		expect(out.partial.rework?.retries).toBe(1);
		expect(out.partial.rework?.tokenShare).toBe(0.25);
		expect(out.partial.cost?.tokens).toBe(400);
		expect(out.partial.cost?.usd).toBe(4);
		expect(out.partial.human?.decisions).toBe(2);
	});

	it("has no rework when the checks pass first time", async () => {
		const { exec, calls } = fakeExec({});
		const out = await claudeSerial.run(context(exec));
		expect(claudeCalls(calls)).toHaveLength(1);
		expect(out.partial.rework?.retries).toBe(0);
		expect(out.partial.human?.decisions).toBe(1);
	});

	it("stops after the suite's review rounds", async () => {
		const { exec, calls } = fakeExec({ checks: Array(20).fill(1) });
		const out = await claudeSerial.run(context(exec, { reviews: 2 }));
		expect(claudeCalls(calls)).toHaveLength(3);
		expect(out.partial.rework?.retries).toBe(2);
	});

	it("stops when the spend cap is used up", async () => {
		const { exec, calls } = fakeExec({
			sessions: [{ tokens: 100, usd: 5 }],
			checks: [1, 1],
		});
		const out = await claudeSerial.run(context(exec, { usd: 5 }));
		expect(claudeCalls(calls)).toHaveLength(1);
		expect(out.stoppedBy).toBe("budget");
	});
});

describe("claude-orchestrated", () => {
	it("gets claude-serial's brief plus the invitation, on the same terms", async () => {
		const { exec, calls } = fakeExec({});
		const ctx = context(exec);
		const out = await claudeOrchestrated.run(ctx);
		const [s] = claudeCalls(calls);
		expect(s?.stdin).toBe(`${epicBrief(ctx)}\n\n${INVITATION}`);
		expect(s?.stdin).toMatch(/subagents/);
		expect(s?.stdin).toMatch(/worktrees/);
		expect(flag(s?.cmd ?? [], "--model")).toBe("sonnet");
		expect(flag(s?.cmd ?? [], "--max-budget-usd")).toBe("40.00");
		expect(s?.env.CLAUDE_CONFIG_DIR).toBe(join(ctx.artifacts, "claude-config"));
		expect(out.branch).toBe("eval/ACME-500/claude-orchestrated");
		expect(out.branchesToMerge).toBe(1);
	});

	it("is an arm the CLI can run", () => {
		expect(ARMS["claude-orchestrated"]).toBe(claudeOrchestrated);
	});
});

describe("claude-parallel", () => {
	it("counts one review per branch and hands back the branches it merged", async () => {
		const { exec, calls } = fakeExec({});
		const ctx = context(exec);
		ctx.epic.children = [
			{ key: "ACME-501", touches: ["src/delivery/**"] },
			{ key: "ACME-502", touches: ["src/pricing/**"] },
		];
		const out = await claudeParallel.run(ctx);
		expect(claudeCalls(calls)).toHaveLength(2);
		expect(out.branchesToMerge).toBe(2);
		expect(out.childBranches).toEqual([
			"eval/ACME-500/claude-parallel-ACME-501",
			"eval/ACME-500/claude-parallel-ACME-502",
		]);
		expect(out.partial.human?.decisions).toBe(2);
	});

	it("gives each session the epic's ticket and its own, not the others'", async () => {
		const { exec, calls } = fakeExec({});
		const ctx = context(exec);
		ctx.epic.children = [
			{ key: "ACME-501", touches: ["src/delivery/**"] },
			{ key: "ACME-502", touches: ["src/pricing/**"] },
		];
		await claudeParallel.run(ctx);
		const briefs = claudeCalls(calls).map((c) => c.stdin ?? "");
		const t501 = ticket("ACME-501", ctx.tickets.children["ACME-501"] ?? "");
		const t502 = ticket("ACME-502", ctx.tickets.children["ACME-502"] ?? "");
		const mine = briefs.find((b) => b.includes(t501)) ?? "";
		expect(mine).toBe(childBrief(ctx, "ACME-501", ["src/delivery/**"]));
		expect(mine).toContain(ticket("ACME-500", ctx.tickets.epic));
		expect(mine).not.toContain(t502);
		expect(briefs.filter((b) => b.includes(t502))).toHaveLength(1);
	});
});

describe("portia", () => {
	/** A Portia checkout with its skill, and a profiles directory, as the operator has them. */
	async function withPortia(
		profiles: string[],
		body: (o: { checkout: string; profiles: string }) => Promise<void>,
	) {
		const checkout = join(dir, "portia");
		mkdirSync(join(checkout, "skills", "portia"), { recursive: true });
		const profilesDir = join(dir, "profiles");
		mkdirSync(profilesDir, { recursive: true });
		for (const p of profiles)
			writeFileSync(join(profilesDir, `${p}.ts`), "export default {};\n");
		const before = {
			checkout: process.env.PORTIA_CHECKOUT,
			profiles: process.env.PORTIA_PROFILES_DIR,
		};
		process.env.PORTIA_CHECKOUT = checkout;
		process.env.PORTIA_PROFILES_DIR = profilesDir;
		try {
			await body({ checkout, profiles: profilesDir });
		} finally {
			if (before.checkout === undefined) delete process.env.PORTIA_CHECKOUT;
			else process.env.PORTIA_CHECKOUT = before.checkout;
			if (before.profiles === undefined) delete process.env.PORTIA_PROFILES_DIR;
			else process.env.PORTIA_PROFILES_DIR = before.profiles;
		}
	}

	it("gets its isolated home, the scripted person and only its own skill", async () => {
		await withPortia(["acme-shop"], async ({ checkout }) => {
			const { exec, calls } = fakeExec({});
			const ctx = context(exec);
			await portia.run(ctx);
			const [s] = claudeCalls(calls);
			expect(s?.stdin).toBe("/portia ACME-500");
			expect(flag(s?.cmd ?? [], "--model")).toBe("sonnet");
			expect(s?.env.PORTIA_HOME).toBe(join(ctx.artifacts, "portia-home"));
			expect(s?.env.PORTIA_EVAL_ANSWERS).toBe(ctx.person);
			const skills = join(ctx.artifacts, "claude-config", "skills");
			expect(readdirSync(skills)).toEqual(["portia"]);
			expect(lstatSync(join(skills, "portia")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(skills, "portia"))).toBe(
				join(checkout, "skills", "portia"),
			);
		});
	});

	it("hands its workers the run's login in an owner-only file, gone once the run ends", async () => {
		await withPortia(["acme-shop"], async () => {
			const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
			process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-example";
			try {
				const { exec: fake } = fakeExec({});
				let seen: { file?: string; text?: string; mode?: number } = {};
				const exec: Exec = async (cmd, o) => {
					if (cmd[0] === "claude") {
						const file = o.env.PORTIA_WORKER_TOKEN_FILE;
						seen = {
							file,
							text: file ? readFileSync(file, "utf8") : undefined,
							mode: file ? statSync(file).mode & 0o777 : undefined,
						};
					}
					return fake(cmd, o);
				};
				await portia.run(context(exec));
				expect(seen.text).toBe("sk-ant-oat01-example");
				expect(seen.mode).toBe(0o600);
				expect(existsSync(seen.file as string)).toBe(false);
			} finally {
				if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
				else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
			}
		});
	});

	it("names the repo's profile outright, since the clone's folder is not the repo's name", async () => {
		await withPortia(["acme-shop"], async ({ profiles }) => {
			const { exec, calls } = fakeExec({});
			await portia.run(context(exec));
			const [s] = claudeCalls(calls);
			// The run's own profile: the repo's, named outright, with the run's prefix and worktrees.
			const runProfile = s?.env.PORTIA_PROFILE as string;
			expect(runProfile).toBe(join(dir, "artifacts", "portia-profile.ts"));
			const text = readFileSync(runProfile, "utf8");
			expect(text).toContain(
				`import base from ${JSON.stringify(join(profiles, "acme-shop.ts"))}`,
			);
			expect(text).toMatch(/branchPrefix: "eval-rartifacts-[a-z0-9]+"/);
			expect(text).toContain(
				JSON.stringify(join(dir, "artifacts", "worktrees")),
			);
			// It loads as a module: the repo's settings kept, only the prefix and worktrees changed.
			writeFileSync(
				join(profiles, "acme-shop.ts"),
				'export default { repo: "acme-shop", branchPrefix: "epic", waveCap: 4 };\n',
			);
			const loaded = (await import(`${runProfile}?t=${Date.now()}`)).default;
			expect(loaded).toMatchObject({ repo: "acme-shop", waveCap: 4 });
			expect(loaded.branchPrefix).toMatch(/^eval-r/);
			expect(s?.env.PORTIA_PROFILES_DIR).toBe(profiles);
		});
	});

	it("stops before any session when the repo has no profile", async () => {
		await withPortia(["clone"], async ({ profiles }) => {
			const { exec, calls } = fakeExec({});
			await expect(portia.run(context(exec))).rejects.toThrow(
				`no Portia profile for acme-shop: expected ${join(profiles, "acme-shop.ts")}`,
			);
			expect(claudeCalls(calls)).toEqual([]);
		});
	});

	it("points origin at the suite's remote when it names one", async () => {
		const clone = join(dir, "clone");
		await git(clone, ["remote", "add", "origin", "/local/acme-shop"]);
		await withPortia(["acme-shop"], async () => {
			const { exec } = fakeExec({});
			const ctx = context(exec);
			ctx.repo.remote = "git@github.com:mousedown/acme-shop.git";
			await portia.run(ctx);
		});
		expect(await git(clone, ["remote", "get-url", "origin"])).toBe(
			"git@github.com:mousedown/acme-shop.git",
		);
	});

	it("leaves origin as the source when the suite names no remote", async () => {
		const clone = join(dir, "clone");
		await git(clone, ["remote", "add", "origin", "/local/acme-shop"]);
		await withPortia(["acme-shop"], async () => {
			const { exec } = fakeExec({});
			await portia.run(context(exec));
		});
		expect(await git(clone, ["remote", "get-url", "origin"])).toBe(
			"/local/acme-shop",
		);
	});
});

describe("suite v1", () => {
	it("pins one model and names the repo's own checks", () => {
		const suite = loadSuite(join(import.meta.dir, "../suites/v1/suite.json"));
		expect(suite.model).toBe("sonnet");
		expect(suite.limits.reviews).toBe(3);
		expect(suite.repos[0]?.checks.length).toBeGreaterThan(0);
	});

	it("has a ticket for every epic and child, the child's naming its epic", () => {
		const suite = loadSuite(join(import.meta.dir, "../suites/v1/suite.json"));
		for (const epic of suite.repos.flatMap((r) => r.epics)) {
			const t = loadTickets(suite, epic);
			expect(t.epic.split("\n")[0]).toBe(`# ${epic.title}`);
			for (const c of epic.children)
				expect(t.children[c.key]).toContain(`Part of ${epic.key}: `);
		}
	});

	it("refuses an epic whose ticket is missing", () => {
		const suite = loadSuite(join(import.meta.dir, "../suites/v1/suite.json"));
		const { epic } = findEpic(suite, "ACME-500");
		expect(() =>
			loadTickets(suite, {
				...epic,
				children: [{ key: "ACME-599", touches: [] }],
			}),
		).toThrow("no ticket for ACME-599");
	});
});

describe("briefs", () => {
	const suite = loadSuite(join(import.meta.dir, "../suites/v1/suite.json"));

	/** Every word each non-Portia arm is given for an epic of suite v1. */
	async function everyBrief(key: string) {
		const { repo, epic } = findEpic(suite, key);
		const ctx: ArmContext = {
			...context(fakeExec({}).exec),
			repo,
			epic,
			tickets: loadTickets(suite, epic),
		};
		const goal = flag(bernsteinCommand(ctx), "--goal") ?? "";
		const branch = `eval/${key}/claude-workflow`;
		const agents = await runWorkflowScript(ctx, branch);
		return {
			ctx,
			epic: epicBrief(ctx),
			children: Object.fromEntries(
				epic.children.map((c) => [c.key, childBrief(ctx, c.key, c.touches)]),
			),
			all: [
				epicBrief(ctx),
				`${epicBrief(ctx)}\n\n${INVITATION}`,
				goal,
				workflowPrompt(ctx, branch),
				...agents.map((a) => a.prompt),
				...epic.children.map((c) => childBrief(ctx, c.key, c.touches)),
			],
		};
	}

	it("gives the baselines the tickets' contract, word for word", async () => {
		const b = await everyBrief("ACME-500");
		// A zone rate, an error string and a status code that are only in the tickets.
		for (const detail of [
			"| C | 1500 cents |",
			'`422` with `{ "error": "no zone for mesa" }`',
			'`reason: "missed target"`',
			"`202` when accepted",
		])
			expect(b.epic).toContain(detail);
		expect(b.epic).toContain(ticket("ACME-500", b.ctx.tickets.epic));
		for (const [key, text] of Object.entries(b.ctx.tickets.children))
			expect(b.epic).toContain(ticket(key, text));
		expect(flag(bernsteinCommand(b.ctx), "--goal")).toBe(b.epic);

		const pricing = b.children["ACME-502"] ?? "";
		expect(pricing).toContain("| C | 1500 cents |");
		expect(pricing).toContain(ticket("ACME-500", b.ctx.tickets.epic));
		expect(pricing).not.toContain('reason: "missed target"');
	});

	for (const key of ["ACME-400", "ACME-500"])
		it(`never shows an arm a hidden spec or the reference solution (${key})`, async () => {
			const b = await everyBrief(key);
			const dir = hiddenDir(suite, b.ctx.epic);
			// Every line of a spec long enough to be its own, rather than a closing bracket.
			const lines = readdirSync(dir)
				.filter((f) => f.endsWith(".ts"))
				.flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
				.map((l) => l.trim())
				.filter((l) => l.length >= 24);
			expect(lines.length).toBeGreaterThan(50);
			for (const brief of b.all) {
				for (const l of lines) expect(brief).not.toContain(l);
				expect(brief).not.toContain(".spec.ts");
				expect(brief).not.toContain(".eval-hidden");
				expect(brief).not.toContain(`reference/${key}`);
			}
		});
});

describe("bernstein", () => {
	/** A stand-in for the real `claude` that records what Bernstein's agent would have run. */
	function fakeClaude(): { bin: string; args: string; env: string } {
		const bin = join(dir, "real-bin");
		mkdirSync(bin);
		const args = join(dir, "claude.args");
		const env = join(dir, "claude.env");
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nenv > '${env}'\n`,
		);
		chmodSync(join(bin, "claude"), 0o755);
		return { bin, args, env };
	}

	/** `bernstein run` as a fake: one agent call through the shim, then the records it keeps. */
	function bernsteinExec(): { exec: Exec; calls: Call[] } {
		const calls: Call[] = [];
		const exec: Exec = async (cmd, x) => {
			calls.push({ cmd, cwd: x.cwd, env: x.env });
			if (cmd[4] !== "run") return { exitCode: 0, stdout: "", stderr: "" };
			// Bernstein's filter keeps PATH and HOME and drops the rest. The shim is first on
			// PATH; it is named here, so nothing can find the operator's real claude instead.
			const shim = join(x.env.PATH?.split(":")[0] ?? "", "claude");
			const p = Bun.spawn(
				[
					shim,
					"--model",
					"claude-sonnet-4-6",
					"--fallback-model",
					"claude-haiku-4-5-20251001",
					"--permission-mode",
					"bypassPermissions",
					"-p",
					"do the task",
				],
				{ cwd: x.cwd, env: { PATH: x.env.PATH ?? "", HOME: "/nowhere" } },
			);
			await p.exited;
			const sdd = join(x.cwd, ".sdd");
			for (const d of ["cost", "archive", "runs/r-1", "worktrees/a"])
				mkdirSync(join(sdd, d), { recursive: true });
			const rows = (xs: object[]) =>
				xs.map((r) => JSON.stringify(r)).join("\n");
			writeFileSync(
				join(sdd, "cost", "ledger.jsonl"),
				rows([
					{
						task_id: "t1",
						model: "claude-sonnet",
						input_tokens: 300,
						cost_usd: 3,
					},
					{
						task_id: "t2",
						model: "claude-sonnet",
						output_tokens: 100,
						cost_usd: 1,
					},
				]),
			);
			writeFileSync(
				join(sdd, "archive", "tasks.jsonl"),
				rows([
					{
						task_id: "t1",
						title: "pricing",
						status: "failed",
						created_at: 1,
						duration_seconds: 180,
					},
					{
						task_id: "t2",
						title: "pricing",
						status: "done",
						created_at: 2,
						duration_seconds: 60,
					},
				]),
			);
			writeFileSync(join(sdd, "runs", "r-1", "journal.jsonl"), "{}\n");
			writeFileSync(join(sdd, "worktrees", "a", "big"), "x");
			return { exitCode: 0, stdout: "done", stderr: "" };
		};
		return { exec, calls };
	}

	async function withFakeClaude<T>(
		f: (c: ReturnType<typeof fakeClaude>) => Promise<T>,
	) {
		const c = fakeClaude();
		const before = process.env.PATH;
		process.env.PATH = `${c.bin}:${before}`;
		try {
			return await f(c);
		} finally {
			process.env.PATH = before;
		}
	}

	it("runs the pinned Bernstein on the brief, through Claude Code, under the run's hard cap", () => {
		const ctx = context(fakeExec({}).exec);
		const cmd = bernsteinCommand(ctx);
		expect(cmd.slice(0, 5)).toEqual([
			"uvx",
			"--from",
			`bernstein==${BERNSTEIN_VERSION}`,
			"bernstein",
			"run",
		]);
		expect(flag(cmd, "--goal")).toBe(epicBrief(ctx));
		expect(flag(cmd, "--cli")).toBe("claude");
		expect(flag(cmd, "--model")).toBe("sonnet");
		expect(flag(cmd, "--routing")).toBe("static");
		expect(flag(cmd, "--hard-budget")).toBe("40.00");
		// The soft cap reroutes to a cheaper model at 80%.
		expect(cmd).not.toContain("--budget");
		expect(cmd).not.toContain("--max-cost-usd");
		expect(cmd).toContain("--auto-approve");
		expect(flag(cmd, "--wait")).toBe(String(180 * 60));
	});

	it("gives its agents the clean config and the suite's model, whatever Bernstein asks for", async () => {
		await withFakeClaude(async (c) => {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok'en";
			try {
				const { exec, calls } = bernsteinExec();
				const ctx = context(exec);
				await bernstein.run(ctx);
				const [run] = calls;
				const bin = join(ctx.artifacts, "bernstein", "bin");
				expect(run?.cwd).toBe(ctx.clone);
				expect(run?.env.PATH?.startsWith(`${bin}:`)).toBe(true);

				const args = readFileSync(c.args, "utf8").trim().split("\n");
				expect(flag(args, "--model")).toBe("sonnet");
				expect(args).not.toContain("--fallback-model");
				expect(args).not.toContain("claude-haiku-4-5-20251001");
				// Bernstein's own choices stand.
				expect(flag(args, "--permission-mode")).toBe("bypassPermissions");
				expect(flag(args, "-p")).toBe("do the task");

				const env = readFileSync(c.env, "utf8");
				expect(env).toContain(
					`CLAUDE_CONFIG_DIR=${join(ctx.artifacts, "claude-config")}\n`,
				);
				expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok'en\n");
				expect(env).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\n");
				// The token is gone once the run is over.
				expect(existsSync(join(bin, "session.env"))).toBe(false);
				expect(
					readFileSync(
						join(ctx.artifacts, "bernstein", "claude-calls.log"),
						"utf8",
					),
				).toContain("--fallback-model claude-haiku-4-5-20251001");
			} finally {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			}
		});
	});

	it("reports cost and rework from its ledger and archive, and keeps its receipts", async () => {
		await withFakeClaude(async () => {
			const { exec, calls } = bernsteinExec();
			const ctx = context(exec);
			const out = await bernstein.run(ctx);
			expect(out.branch).toBe("eval/ACME-500/bernstein");
			expect(out.branchesToMerge).toBe(1);
			expect(out.stoppedBy).toBeUndefined();
			expect(out.partial.cost?.tokens).toBe(400);
			expect(out.partial.cost?.tokensByModel).toEqual({ "claude-sonnet": 400 });
			expect(out.partial.cost?.usd).toBe(4);
			expect(out.partial.cost?.workMinutes).toBe(4);
			// The second "pricing" task is a retry of the first, which failed.
			expect(out.partial.rework).toEqual({
				retries: 1,
				failedLands: 1,
				tokenShare: 0.25,
				minuteShare: 0.25,
			});
			expect(out.partial.human?.decisions).toBe(0);

			const kept = join(ctx.artifacts, "bernstein");
			expect(existsSync(join(kept, "sdd", "cost", "ledger.jsonl"))).toBe(true);
			expect(
				existsSync(join(kept, "sdd", "runs", "r-1", "journal.jsonl")),
			).toBe(true);
			expect(existsSync(join(kept, "sdd", "worktrees"))).toBe(false);
			expect(readFileSync(join(kept, "version.txt"), "utf8").trim()).toBe(
				BERNSTEIN_VERSION,
			);

			const key = join(kept, "receipt-key.pem");
			expect(calls[1]?.cmd).toEqual([
				"openssl",
				"genpkey",
				"-algorithm",
				"ed25519",
				"-out",
				key,
			]);
			const verbs = calls.slice(2).map((c) => c.cmd.slice(4));
			expect(verbs[0]).toEqual([
				"verify",
				"run",
				"r-1",
				"-w",
				ctx.clone,
				"--signing-key-path",
				key,
				"-o",
				join(kept, "receipts", "r-1", "run-receipt.json"),
			]);
			expect(verbs[1]?.slice(0, 5)).toEqual([
				"lineage",
				"export",
				"r-1",
				"--format",
				"jsonld",
			]);
		});
	});

	it("is an arm the CLI can run", () => {
		expect(ARMS.bernstein).toBe(bernstein);
	});
});

describe("claude-workflow", () => {
	const suiteDir = join(import.meta.dir, "../suites/v1");
	const workflowContext = (exec: Exec) => ({
		...context(exec),
		person: join(suiteDir, "person.json"),
	});

	it("runs the frozen script as a saved workflow, on the same terms as every arm", async () => {
		const { exec, calls } = fakeExec({});
		const ctx = workflowContext(exec);
		const out = await claudeWorkflow.run(ctx);
		const [s] = claudeCalls(calls);
		const branch = "eval/ACME-500/claude-workflow";
		expect(s?.stdin).toBe(
			`/${WORKFLOW} ${JSON.stringify(workflowArgs(ctx, branch))}`,
		);
		expect(flag(s?.cmd ?? [], "--model")).toBe("sonnet");
		expect(flag(s?.cmd ?? [], "--permission-mode")).toBe("acceptEdits");
		expect(flag(s?.cmd ?? [], "--allowedTools")).toBe("Bash");
		expect(s?.cmd).toContain(`Workflow(${WORKFLOW})`);
		expect(s?.cmd).toContain("--strict-mcp-config");
		expect(flag(s?.cmd ?? [], "--max-budget-usd")).toBe("40.00");
		expect(s?.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet");
		const config = join(ctx.artifacts, "claude-config");
		expect(s?.env.CLAUDE_CONFIG_DIR).toBe(config);
		// The suite's script, unchanged, and nothing else in the clean config.
		expect(readdirSync(join(config, "workflows"))).toEqual([`${WORKFLOW}.js`]);
		expect(
			readFileSync(join(config, "workflows", `${WORKFLOW}.js`), "utf8"),
		).toBe(readFileSync(join(suiteDir, "workflow.js"), "utf8"));
		expect(readdirSync(join(config, "skills"))).toEqual([]);

		const settings = JSON.parse(
			readFileSync(flag(s?.cmd ?? [], "--settings") ?? "", "utf8"),
		);
		for (const event of ["TaskCompleted", "SubagentStop"])
			expect(settings.hooks[event][0].hooks[0].command).toBe(
				`bun '${join(ctx.artifacts, "workflow", "gate.js")}'`,
			);

		expect(out.branch).toBe(branch);
		expect(out.branchesToMerge).toBe(1);
		expect(out.partial.human?.decisions).toBe(0);
		expect(out.partial.rework?.retries).toBe(0);
	});

	it("gates a finishing agent on the repo's checks, up to the suite's reviews", async () => {
		const ctx = context(fakeExec({}).exec, { reviews: 1 });
		const work = join(dir, "worktree");
		mkdirSync(work);
		const gateDir = join(ctx.artifacts, "workflow");
		mkdirSync(gateDir);
		const gate = (checks: string[], input: object) => {
			gateSettings({ ...ctx, repo: { ...ctx.repo, checks } }, gateDir);
			const p = Bun.spawnSync(["bun", join(gateDir, "gate.js")], {
				stdin: new TextEncoder().encode(JSON.stringify(input)),
				stdout: "pipe",
				stderr: "pipe",
			});
			return { code: p.exitCode, stderr: p.stderr.toString() };
		};
		const input = {
			hook_event_name: "SubagentStop",
			agent_id: "a1",
			cwd: work,
		};
		expect(gate(["true"], input).code).toBe(0);
		const blocked = gate(["true", "echo nope; false"], input);
		expect(blocked.code).toBe(2);
		expect(blocked.stderr).toContain("$ echo nope; false\nnope");
		expect(blocked.stderr).toContain(work);
		// One block per agent at reviews 1; then it is let go, and another agent is gated.
		expect(gate(["false"], input).code).toBe(0);
		expect(gate(["false"], { ...input, agent_id: "a2" }).code).toBe(2);
		expect(
			gate(["false"], { ...input, agent_id: "a3", agent_type: "Explore" }).code,
		).toBe(0);
		const rows = readFileSync(join(gateDir, "gate.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows.map((r) => r.blocked)).toEqual([false, true, false, true]);
		expect(rows[1].cwd).toBe(work);
	});

	it("counts each block as rework", async () => {
		const { exec } = fakeExec({});
		const ctx = workflowContext(exec);
		const gate = join(ctx.artifacts, "workflow", "gate.jsonl");
		const withGate: Exec = async (cmd, x) => {
			writeFileSync(
				gate,
				`${[true, false, true].map((blocked) => JSON.stringify({ blocked })).join("\n")}\n`,
			);
			return exec(cmd, x);
		};
		const out = await claudeWorkflow.run({ ...ctx, exec: withGate });
		expect(out.partial.rework?.retries).toBe(2);
	});

	it("fans out one worktree agent per ticket, then merges their branches", async () => {
		const ctx = context(fakeExec({}).exec);
		ctx.epic.children = [
			{ key: "ACME-501", touches: ["src/delivery/**"] },
			{ key: "ACME-502", touches: ["src/pricing/**"] },
		];
		const branch = "eval/ACME-500/claude-workflow";
		const agents = await runWorkflowScript(ctx, branch);
		expect(agents).toHaveLength(3);
		for (const a of agents.slice(0, 2)) {
			expect(a.opts.isolation).toBe("worktree");
			expect(a.opts.phase).toBe("Tickets");
		}
		expect(agents[0]?.prompt).toContain(`git checkout -b`);
		expect(agents[0]?.prompt).toContain(`${branch}/ACME-501`);
		expect(agents[0]?.prompt).toContain("src/delivery/**");
		const merge = agents[2];
		expect(merge?.opts.isolation).toBeUndefined();
		expect(merge?.prompt).toContain(`branch ${branch}/ACME-501`);
		expect(merge?.prompt).toContain(`branch ${branch}/ACME-502`);
		expect(merge?.prompt).toContain("R1: a crate is listed");
		// Each ticket agent gets the epic's ticket and its own; the merge agent gets them all.
		const [epic, t501, t502] = [
			ticket("ACME-500", ctx.tickets.epic),
			ticket("ACME-501", ctx.tickets.children["ACME-501"] ?? ""),
			ticket("ACME-502", ctx.tickets.children["ACME-502"] ?? ""),
		];
		expect(agents[0]?.prompt).toContain(epic);
		expect(agents[0]?.prompt).toContain(t501);
		expect(agents[0]?.prompt).not.toContain(t502);
		expect(agents[1]?.prompt).toContain(t502);
		expect(agents[1]?.prompt).not.toContain(t501);
		for (const t of [epic, t501, t502]) expect(merge?.prompt).toContain(t);
	});

	it("is an arm the CLI can run", () => {
		expect(ARMS["claude-workflow"]).toBe(claudeWorkflow);
	});
});

describe("workersUsd", () => {
	it("adds every detached worker's own bill, which the orchestrator's session does not include", () => {
		const run = mkdtempSync(join(tmpdir(), "eval-workers-"));
		const result = (usd: number) =>
			JSON.stringify({
				type: "result",
				subtype: "success",
				total_cost_usd: usd,
			});
		writeFileSync(
			join(run, "worker-A-1.log"),
			`{"type":"assistant"}\n${result(0.25)}\n`,
		);
		writeFileSync(join(run, "worker-B-1.log"), `${result(0.5)}\nnot json\n`);
		writeFileSync(join(run, "runlog.jsonl"), result(9));
		expect(workersUsd(run)).toBeCloseTo(0.75);
		expect(workersUsd(join(run, "missing"))).toBe(0);
	});
});

describe("scoredBranch", () => {
	it("scores the integration branch as pushed, since Portia lands children on the remote", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-scored-"));
		const origin = join(root, "origin.git");
		await git(root, ["init", "-q", "--bare", "-b", "main", origin]);
		const seed = join(root, "seed");
		await git(root, ["clone", "-q", origin, seed]);
		for (const [k, v] of [
			["user.name", "t"],
			["user.email", "t@t"],
			["commit.gpgsign", "false"],
		] as const)
			await git(seed, ["config", k, v]);
		writeFileSync(join(seed, "a.txt"), "a\n");
		await git(seed, ["add", "-A"]);
		await git(seed, ["commit", "-qm", "base"]);
		await git(seed, [
			"push",
			"-q",
			"origin",
			"HEAD:main",
			"HEAD:refs/heads/eval-r1-x/ACME-400",
		]);
		const clone = join(root, "clone");
		await git(root, ["clone", "-q", origin, clone]);
		await git(clone, [
			"branch",
			"eval-r1-x/ACME-400",
			"origin/eval-r1-x/ACME-400",
		]);
		// A child lands on the remote after the clone took its copy.
		writeFileSync(join(seed, "b.txt"), "landed\n");
		await git(seed, ["add", "-A"]);
		await git(seed, ["commit", "-qm", "land"]);
		await git(seed, [
			"push",
			"-q",
			"origin",
			"HEAD:refs/heads/eval-r1-x/ACME-400",
		]);

		const branch = await scoredBranch(
			clone,
			"ACME-400",
			"eval-r1-x",
			origin,
			"main",
		);
		expect(branch).toBe("origin/eval-r1-x/ACME-400");
		expect(await git(clone, ["show", `${branch}:b.txt`])).toContain("landed");
		rmSync(root, { recursive: true, force: true });
	});
});

describe("the scripted person's unscripted answer", () => {
	const ask = {
		tokens: 100,
		usd: 1,
		text: "Two ways to go.\n\nWhich option do you want?",
	};
	const done = { tokens: 50, usd: 0.5, text: "Done: every check passes." };

	it("a session that ends on a question asks the person; one that ends on a statement does not", () => {
		expect(
			asksThePerson("I need a decision.\n\n**Which option do you want?**"),
		).toBe(true);
		expect(asksThePerson("Shall I go ahead?")).toBe(true);
		expect(asksThePerson("Done: every check passes.")).toBe(false);
		expect(
			asksThePerson("Was it hard? Yes.\n\nIt is merged and the checks pass."),
		).toBe(false);
		// Portia's run 3 asked this way and was not answered.
		expect(
			asksThePerson(
				"Options: 1, 2 or 3.\n\nWhich should I do? For option 1 or 2, tell me whether I should create the ticket or you will.",
			),
		).toBe(true);
		expect(
			asksThePerson("Let me know which approach you prefer before I continue."),
		).toBe(true);
		// Portia's run 11 put the ask above a closing note.
		expect(
			asksThePerson(
				"ACME-403 needs src/pricing/routes.ts.\n\nIf you approve, I'll run these two steps, then drive again:\n1. allow the file\n2. answer the park\n\nI'd leave the profile's allowedIncidental unchanged.",
			),
		).toBe(true);
		expect(
			asksThePerson(
				"The epic PR is #15, ready for a person to review and merge.",
			),
		).toBe(false);
	});

	it("resumes a session that stops on a question with the person's answer, and counts the answer", async () => {
		const { exec, calls } = fakeExec({ sessions: [ask, done] });
		const { session, answers } = await answeredSession(context(exec), {
			cwd: join(dir, "clone"),
			prompt: "/portia ACME-400",
			name: "orchestrator",
		});
		expect(answers).toBe(1);
		const [first, second] = claudeCalls(calls);
		expect(first?.stdin).toBe("/portia ACME-400");
		expect(flag(second?.cmd ?? [], "--resume")).toBe("s1");
		expect(second?.stdin).toBe(unscripted("/no/person.json").answer);
		expect(session).toMatchObject({ tokens: 150, usd: 1.5, result: done.text });
	});

	it("answers no more than the person's limit", async () => {
		const { exec, calls } = fakeExec({
			sessions: [ask, ask, ask, ask, ask, ask],
		});
		const { answers } = await answeredSession(context(exec), {
			cwd: join(dir, "clone"),
			prompt: "go",
			name: "session",
		});
		expect(answers).toBe(3);
		expect(claudeCalls(calls)).toHaveLength(4);
	});

	it("a baseline's answered question is a decision, not rework", async () => {
		const { exec } = fakeExec({ sessions: [ask, done] });
		const r = await reviewedSession(context(exec), {
			cwd: join(dir, "clone"),
			prompt: "deliver the epic",
			name: "session",
		});
		expect(r.rework.retries).toBe(0);
		expect(r.decisions).toBe(2);
	});

	it("person.json can set its own answer and limit", () => {
		const file = join(dir, "person.json");
		writeFileSync(
			file,
			JSON.stringify({ unscripted: { answer: "Option 1.", max: 1 } }),
		);
		expect(unscripted(file)).toEqual({ answer: "Option 1.", max: 1 });
	});
});
