import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git } from "../metrics/git";
import { minutesBetween } from "../metrics/time";
import type { Scores } from "../types";
import type { Arm, ArmContext, ArmOutcome } from ".";
import { claudeCommand, epicBrief, sessionEnv, spawnExec } from "./claude";

/**
 * Bernstein's release for suite v1. It releases often; a new suite version pins a new one,
 * which invalidates only this arm's cached baseline.
 */
export const BERNSTEIN_VERSION = "3.23.0";

/**
 * Bernstein (pypi `bernstein`) given the epic brief: one LLM decomposition step, then its
 * deterministic scheduler runs a Claude Code agent per task in its own worktree, gates it
 * and merges it onto the current branch. It has no step where a person signs off specs,
 * so nothing is asked of the scripted person.
 *
 * Bernstein builds its own `claude` command lines and filters the environment its agents
 * get, which would drop the clean config dir and the subscription token and let it pick a
 * fallback model. So its agents find a `claude` shim first on PATH that puts back the
 * session environment every arm gets and pins `--model` to the suite's. Everything else
 * (its permissions, per-task caps, gates and retries) is Bernstein's own design.
 */
export const bernstein: Arm = {
	name: "bernstein",
	description: `Bernstein ${BERNSTEIN_VERSION} given the epic brief: it plans once, then runs a Claude Code agent per task in its own worktree, gates and merges each.`,
	async run(ctx) {
		const branch = `eval/${ctx.epic.key}/bernstein`;
		await git(ctx.clone, ["checkout", "-b", branch]);
		const out = join(ctx.artifacts, "bernstein");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "version.txt"), `${BERNSTEIN_VERSION}\n`);
		const bin = claudeShim(ctx, out);
		const exec = ctx.exec ?? spawnExec;
		const started = new Date();
		const env = sessionEnv(process.env);
		const cmd = bernsteinCommand(ctx);
		ctx.log(`bernstein: ${cmd.slice(0, 6).join(" ")} … in ${ctx.clone}`);
		let r: Awaited<ReturnType<typeof exec>>;
		try {
			r = await exec(cmd, {
				cwd: ctx.clone,
				env: { ...env, PATH: `${bin}:${env.PATH ?? ""}` },
				// --wait gets the run's minutes; this is the backstop if it overruns them.
				timeoutMs: (ctx.limits.minutes + 5) * 60_000,
			});
		} finally {
			// The token never outlives the run, and never sits in its artifacts.
			rmSync(join(bin, "session.env"), { force: true });
		}
		writeFileSync(join(out, "run.stdout"), r.stdout);
		if (r.stderr) writeFileSync(join(out, "run.stderr"), r.stderr);
		const minutes = minutesBetween(started, new Date());
		const sdd = join(ctx.clone, ".sdd");
		const runIds = await keepRecords(ctx, sdd, out);
		const ledger = readJsonl(join(sdd, "cost", "ledger.jsonl"));
		const tasks = readJsonl(join(sdd, "archive", "tasks.jsonl"));
		const cost = ledgerCost(ledger);
		const unmerged = (
			await git(ctx.clone, ["branch", "--list", "agent/*", "--no-merged"])
		)
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (unmerged.length)
			ctx.log(`bernstein: ${unmerged.length} agent branches left unmerged`);
		ctx.log(
			`bernstein: exit ${r.exitCode}, ${tasks.length} tasks, runs ${runIds.join(", ") || "none"}`,
		);
		return {
			exitCode: r.exitCode,
			stoppedBy:
				minutes >= ctx.limits.minutes
					? "timeout"
					: ctx.limits.usd !== undefined && (cost.usd ?? 0) >= ctx.limits.usd
						? "budget"
						: r.exitCode
							? "error"
							: undefined,
			branch,
			branchesToMerge: 1,
			partial: {
				cost: {
					...cost,
					wallMinutes: minutes,
					workMinutes: tasks.length
						? tasks.reduce((a, t) => a + num(t.duration_seconds), 0) / 60
						: minutes,
				},
				rework: taskRework(tasks, ledger),
				// Plan approval and merges are automatic and specs are never signed off:
				// once started, nothing reaches a person.
				human: { decisions: 0, waitingMinutes: 0 },
			},
		} satisfies ArmOutcome;
	},
};

/** `bernstein run` on the brief, through Claude Code, with the run's cap as its hard cap. */
export function bernsteinCommand(ctx: ArmContext): string[] {
	return [
		"uvx",
		"--from",
		`bernstein==${BERNSTEIN_VERSION}`,
		"bernstein",
		"run",
		"--goal",
		epicBrief(ctx),
		"--cli",
		"claude",
		"--model",
		ctx.model,
		// Fixed routing: the bandit learns across runs, which a cached baseline must not.
		"--routing",
		"static",
		// Not --budget: at 80% of a soft cap it reroutes to a cheaper model.
		...(ctx.limits.usd !== undefined
			? ["--hard-budget", ctx.limits.usd.toFixed(2)]
			: []),
		"--auto-approve",
		"--fresh",
		"--quiet",
		"--wait",
		String(ctx.limits.minutes * 60),
	];
}

/**
 * A `claude` for Bernstein's agents: the real one, with the environment every arm's
 * sessions get (clean config dir, auth, tracker token) that Bernstein's filter drops, the
 * suite's model in place of whatever `--model` it chose, and no `--fallback-model`. Every
 * command line it is given is logged, so a run shows which model each agent asked for.
 */
export function claudeShim(ctx: ArmContext, out: string): string {
	const real = Bun.which("claude", { PATH: process.env.PATH ?? "" });
	if (!real) throw new Error("claude is not on PATH");
	const bin = join(out, "bin");
	mkdirSync(bin, { recursive: true });
	const { env } = claudeCommand(ctx, {});
	const keep = [
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"GH_TOKEN",
		"GITHUB_TOKEN",
	];
	const secrets = join(bin, "session.env");
	writeFileSync(
		secrets,
		keep
			.filter((k) => env[k] !== undefined)
			.map((k) => `export ${k}=${sh(env[k] as string)}\n`)
			.join(""),
		{ mode: 0o600 },
	);
	const shim = join(bin, "claude");
	writeFileSync(
		shim,
		`#!/bin/sh
# Written by the eval harness for one Bernstein run: see claudeShim in eval/src/arms/bernstein.ts.
. ${sh(secrets)}
printf '%s\\n' "$*" >> ${sh(join(out, "claude-calls.log"))}
n=$#
i=0
while [ "$i" -lt "$n" ]; do
	a=$1
	shift
	i=$((i + 1))
	case $a in
	--fallback-model) shift; i=$((i + 1)) ;;
	--model) set -- "$@" --model ${sh(ctx.model)}; shift; i=$((i + 1)) ;;
	*) set -- "$@" "$a" ;;
	esac
done
exec ${sh(real)} "$@"
`,
	);
	chmodSync(shim, 0o755);
	return bin;
}

/**
 * Bernstein's own records, copied into the run's artifacts (`bernstein/sdd`, without the
 * worktrees), plus a signed run receipt and a lineage export per run it journalled, so the
 * review-effort score (#21) can credit them as it does Portia's. A receipt that cannot be
 * built is logged, not fatal: the run is still scored.
 */
async function keepRecords(
	ctx: ArmContext,
	sdd: string,
	out: string,
): Promise<string[]> {
	if (!existsSync(sdd)) return [];
	cpSync(sdd, join(out, "sdd"), {
		recursive: true,
		filter: (src) => !src.startsWith(join(sdd, "worktrees")),
	});
	const runs = join(sdd, "runs");
	const ids = existsSync(runs) ? readdirSync(runs).sort() : [];
	if (!ids.length) return ids;
	const exec = ctx.exec ?? spawnExec;
	const env = sessionEnv(process.env);
	// An eval-only Ed25519 key: the receipt proves what the run recorded, not who ran it.
	const key = join(out, "receipt-key.pem");
	const k = await exec(
		["openssl", "genpkey", "-algorithm", "ed25519", "-out", key],
		{ cwd: out, env },
	);
	for (const id of ids) {
		const dir = join(out, "receipts", id);
		mkdirSync(dir, { recursive: true });
		const steps = [
			...(k.exitCode
				? []
				: [
						[
							"verify",
							"run",
							id,
							"-w",
							ctx.clone,
							"--signing-key-path",
							key,
							"-o",
							join(dir, "run-receipt.json"),
						],
					]),
			[
				"lineage",
				"export",
				id,
				"--format",
				"jsonld",
				"-w",
				ctx.clone,
				"-o",
				join(dir, "lineage.jsonld"),
			],
		];
		for (const step of steps) {
			const s = await exec(
				[
					"uvx",
					"--from",
					`bernstein==${BERNSTEIN_VERSION}`,
					"bernstein",
					...step,
				],
				{ cwd: ctx.clone, env },
			);
			if (s.exitCode)
				ctx.log(
					`bernstein ${step.slice(0, 2).join(" ")} ${id}: exit ${s.exitCode} ${s.stderr.trim().slice(-200)}`,
				);
		}
	}
	return ids;
}

type Row = Record<string, unknown>;

export function readJsonl(file: string): Row[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as Row];
			} catch {
				return [];
			}
		});
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);
const rowTokens = (r: Row) =>
	num(r.input_tokens) +
	num(r.output_tokens) +
	num(r.cache_read_tokens) +
	num(r.cache_write_tokens);

/** Tokens and USD from Bernstein's spend ledger, one row per model call. */
export function ledgerCost(
	ledger: Row[],
): Pick<Scores["cost"], "tokens" | "tokensByModel" | "usd"> {
	const tokensByModel: Record<string, number> = {};
	for (const r of ledger) {
		const m = typeof r.model === "string" ? r.model : "unknown";
		tokensByModel[m] = (tokensByModel[m] ?? 0) + rowTokens(r);
	}
	return {
		tokens: ledger.reduce((a, r) => a + rowTokens(r), 0),
		tokensByModel,
		usd: ledger.length
			? ledger.reduce((a, r) => a + num(r.cost_usd), 0)
			: undefined,
	};
}

/**
 * Rework from the task archive, one row per task that reached a terminal state. A retry
 * comes back as another task with the same title, so every row after a title's first is
 * an attempt after the first; a failed row is a task that did not land.
 */
export function taskRework(tasks: Row[], ledger: Row[]): Scores["rework"] {
	const seen = new Set<string>();
	const later = new Set<string>();
	let laterMinutes = 0;
	const sorted = [...tasks].sort(
		(a, b) => num(a.created_at) - num(b.created_at),
	);
	for (const t of sorted) {
		const title = String(t.title ?? t.task_id);
		if (seen.has(title)) {
			later.add(String(t.task_id));
			laterMinutes += num(t.duration_seconds);
		}
		seen.add(title);
	}
	const tokens = ledger.reduce((a, r) => a + rowTokens(r), 0);
	const laterTokens = ledger
		.filter((r) => later.has(String(r.task_id)))
		.reduce((a, r) => a + rowTokens(r), 0);
	const minutes = tasks.reduce((a, t) => a + num(t.duration_seconds), 0);
	return {
		retries: later.size,
		failedLands: tasks.filter((t) => t.status === "failed").length,
		tokenShare: tokens ? laterTokens / tokens : 0,
		minuteShare: minutes ? laterMinutes / minutes : 0,
	};
}

/** A single-quoted shell word. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
