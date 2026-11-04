import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { minutesBetween } from "../metrics/time";
import type { Scores } from "../types";
import type { ArmContext } from ".";

/** Runs one process to completion. Arms take it from the context so a test can fake it. */
export type Exec = (
	cmd: string[],
	o: {
		cwd: string;
		env: Record<string, string>;
		stdin?: string;
		timeoutMs?: number;
	},
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const spawnExec: Exec = async (cmd, o) => {
	const proc = Bun.spawn(cmd, {
		cwd: o.cwd,
		env: o.env,
		stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = o.timeoutMs
		? setTimeout(() => proc.kill(), o.timeoutMs)
		: undefined;
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { exitCode, stdout, stderr };
};

/**
 * One headless Claude Code session: `claude -p` with the prompt on stdin and JSON out,
 * so tokens and cost come from the session's own result line.
 */
export interface Session {
	exitCode: number;
	tokens: number;
	tokensByModel: Record<string, number>;
	usd?: number;
	minutes: number;
	/** The session's final text. */
	result: string;
	/** To resume it for a review round. */
	sessionId?: string;
	stoppedBy?: "budget" | "timeout" | "error";
}

/**
 * The same session for every arm, so the arms differ only in what they are told:
 * - the suite's pinned model;
 * - a clean config directory for the run, so no user CLAUDE.md, settings, skills, plugins
 *   or MCP servers come along, and the transcripts are kept beside the run;
 * - only the operator environment a session needs (path, git, auth), nothing that tunes it;
 * - edits accepted and the shell allowed, so it can run the repo's own checks: under `-p`,
 *   acceptEdits alone denies every shell command;
 * - the run's spend cap, or what is left of it.
 */
export function claudeCommand(
	ctx: ArmContext,
	o: {
		resume?: string;
		usd?: number;
		/** Skill directories to put in the clean config, and nothing else. */
		skills?: string[];
		/** Tools allowed beside Bash, e.g. `Workflow`. */
		allow?: string[];
		/** A settings file for this session only, e.g. an arm's hooks. */
		settings?: string;
		env?: Record<string, string>;
	},
): { cmd: string[]; env: Record<string, string>; configDir: string } {
	const configDir = join(ctx.artifacts, "claude-config");
	mkdirSync(join(configDir, "skills"), { recursive: true });
	for (const s of o.skills ?? []) {
		const link = join(configDir, "skills", basename(s));
		if (!existsSync(link)) symlinkSync(s, link);
	}
	const usd = o.usd ?? ctx.limits.usd;
	const cmd = [
		"claude",
		"-p",
		"--output-format",
		"json",
		"--model",
		ctx.model,
		"--permission-mode",
		"acceptEdits",
		"--allowedTools",
		"Bash",
		...(o.allow ?? []),
		"--strict-mcp-config",
		...(o.settings ? ["--settings", o.settings] : []),
		...(usd !== undefined ? ["--max-budget-usd", usd.toFixed(2)] : []),
		...(o.resume ? ["--resume", o.resume] : []),
	];
	return {
		cmd,
		env: {
			...sessionEnv(process.env),
			CLAUDE_CONFIG_DIR: configDir,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			// `-p` otherwise exits ten minutes after the last turn even with background work still
			// running (a Portia land, a workflow), cutting the arm off mid-run. The run's own
			// time limit still stops it.
			CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
			...o.env,
		},
		configDir,
	};
}

/**
 * What a session keeps from the operator's environment: enough to find tools, commit,
 * reach the tracker and authenticate. With a fresh config directory there is no stored
 * login, so the subscription comes in as CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`)
 * or an API key.
 */
const KEEP = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"TMPDIR",
	"LANG",
	"SSH_AUTH_SOCK",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
];

export function sessionEnv(
	env: Record<string, string | undefined>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env))
		if (v !== undefined && (KEEP.includes(k) || k.startsWith("LC_")))
			out[k] = v;
	return out;
}

export async function claudeSession(
	ctx: ArmContext,
	o: {
		cwd: string;
		prompt: string;
		name: string;
		resume?: string;
		usd?: number;
		/** Minutes this session may take; the run's limit by default. */
		minutes?: number;
		skills?: string[];
		allow?: string[];
		settings?: string;
		env?: Record<string, string>;
	},
): Promise<Session> {
	const started = new Date();
	const { cmd, env } = claudeCommand(ctx, o);
	ctx.log(`${o.name}: ${cmd.join(" ")} in ${o.cwd}`);
	const limit = o.minutes ?? ctx.limits.minutes;
	const { exitCode, stdout, stderr } = await (ctx.exec ?? spawnExec)(cmd, {
		cwd: o.cwd,
		env,
		stdin: o.prompt,
		timeoutMs: limit * 60_000,
	});
	writeFileSync(join(ctx.artifacts, `${o.name}.json`), stdout);
	if (stderr) writeFileSync(join(ctx.artifacts, `${o.name}.stderr`), stderr);
	const minutes = minutesBetween(started, new Date());
	const { subtype, ...session } = parseSessionResult(stdout);
	return {
		exitCode,
		minutes,
		...session,
		stoppedBy:
			minutes >= limit
				? "timeout"
				: subtype?.includes("budget")
					? "budget"
					: exitCode
						? "error"
						: undefined,
	};
}

/** Claude Code's `--output-format json` result: cost and usage, when it reports them. */
export function parseSessionResult(out: string): {
	tokens: number;
	tokensByModel: Record<string, number>;
	usd?: number;
	result: string;
	sessionId?: string;
	subtype?: string;
} {
	let j: Record<string, unknown> = {};
	try {
		j = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
	} catch {
		return { tokens: 0, tokensByModel: {}, result: out };
	}
	const usage = (j.usage ?? {}) as Record<string, number>;
	const tokens =
		(usage.input_tokens ?? 0) +
		(usage.output_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0);
	const byModel: Record<string, number> = {};
	const mu = (j.modelUsage ?? {}) as Record<string, Record<string, number>>;
	for (const [model, u] of Object.entries(mu))
		byModel[model] =
			(u.inputTokens ?? 0) +
			(u.outputTokens ?? 0) +
			(u.cacheCreationInputTokens ?? 0) +
			(u.cacheReadInputTokens ?? 0);
	return {
		tokens: tokens || Object.values(byModel).reduce((a, b) => a + b, 0),
		tokensByModel: byModel,
		usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined,
		result: typeof j.result === "string" ? j.result : "",
		sessionId: typeof j.session_id === "string" ? j.session_id : undefined,
		subtype: typeof j.subtype === "string" ? j.subtype : undefined,
	};
}

/**
 * A session as its transcript kept it (`<name>.json` in the artifacts), for rebuilding a run
 * from disk without running it. Its minutes run from the line the run's log started it on
 * to the transcript's last write, which is when the session's output landed; its exit is
 * the result's `is_error`. Undefined when there is no transcript.
 */
export function savedSession(
	artifacts: string,
	name: string,
	limitMinutes?: number,
): Session | undefined {
	const file = join(artifacts, `${name}.json`);
	if (!existsSync(file)) return undefined;
	const stdout = readFileSync(file, "utf8");
	const { subtype, ...session } = parseSessionResult(stdout);
	const started = startedAt(artifacts, name);
	const ended = statSync(file).mtime;
	const minutes = started ? Math.max(0, minutesBetween(started, ended)) : 0;
	const exitCode = /"is_error"\s*:\s*true/.test(stdout) ? 1 : 0;
	return {
		exitCode,
		minutes,
		...session,
		stoppedBy:
			limitMinutes !== undefined && minutes >= limitMinutes
				? "timeout"
				: subtype?.includes("budget")
					? "budget"
					: exitCode
						? "error"
						: undefined,
	};
}

/** When the run's log (`eval.log`) shows the session `name` starting. */
function startedAt(artifacts: string, name: string): Date | undefined {
	const log = join(artifacts, "eval.log");
	if (!existsSync(log)) return undefined;
	const line = readFileSync(log, "utf8")
		.split("\n")
		.find((l) => l.includes(` ${name}: claude `));
	const at = line ? new Date(line.split(" ")[0] ?? "") : undefined;
	return at && !Number.isNaN(at.getTime()) ? at : undefined;
}

/** `answeredSession` as its transcripts kept it: `<name>.json`, then each `<name>-answer-<k>.json`. */
export function savedAnsweredSession(
	artifacts: string,
	name: string,
	limitMinutes?: number,
): { session: Session; answers: number } | undefined {
	const rounds: Session[] = [];
	for (let k = 0; ; k++) {
		const s = savedSession(
			artifacts,
			k ? `${name}-answer-${k}` : name,
			limitMinutes,
		);
		if (!s) break;
		rounds.push(s);
	}
	return rounds.length
		? { session: combined(rounds), answers: rounds.length - 1 }
		: undefined;
}

/**
 * A ticket in a brief, word for word as it is filed, fenced so where it starts and ends is
 * plain. The suite's `workflow.js` fences its tickets the same way.
 */
export function ticket(key: string, text: string): string {
	return `<ticket key="${key}">\n${text.trimEnd()}\n</ticket>`;
}

/** A child's ticket text, which every brief needs: a missing one is a broken suite. */
export function childTicket(ctx: ArmContext, key: string): string {
	const text = ctx.tickets.children[key];
	if (text === undefined) throw new Error(`no ticket text for ${key}`);
	return text;
}

/**
 * The epic as every baseline sees it: the same words Portia reads in the tracker, the
 * epic's ticket and every child's in full, so no arm meets a contract detail (a rate, a
 * status code, an error string) only in the hidden specs.
 */
export function epicBrief(ctx: ArmContext): string {
	const scenarios = ctx.epic.scenarios
		.map((s) => `- ${s.id}: ${s.text}`)
		.join("\n");
	const children = ctx.epic.children.length
		? `\n\nThe tickets, with the paths each is expected to change:\n${ctx.epic.children
				.map((c) => `- ${c.key}: ${c.touches.join(", ")}`)
				.join("\n")}`
		: "";
	const tickets = [
		ticket(ctx.epic.key, ctx.tickets.epic),
		...ctx.epic.children.map((c) => ticket(c.key, childTicket(ctx, c.key))),
	].join("\n\n");
	return `You are delivering the feature "${ctx.epic.title}" (${ctx.epic.key}) in this repository.

It is done when every one of these acceptance scenarios holds, with tests that prove it:
${scenarios}${children}

The feature's ticket, then each child ticket, word for word as they are filed in the tracker:

${tickets}

Follow the repository's own CLAUDE.md, lint, typecheck and tests. Commit your work on the current branch as you go. Do not push. When every scenario is covered and the repository's checks pass, stop and summarise what you did and which scenarios each change proves.`;
}

/** A visible check that failed, with the tail of what it printed. */
export interface CheckFailure {
	check: string;
	output: string;
}

/**
 * The scripted reviewer's checks: the repo's own, run in the clone. Never the hidden specs,
 * which are copied in only after the arm has finished.
 */
export async function runChecks(
	ctx: ArmContext,
	cwd: string,
	name: string,
): Promise<CheckFailure[]> {
	const failed: CheckFailure[] = [];
	const log: string[] = [];
	for (const check of ctx.repo.checks) {
		const r = await (ctx.exec ?? spawnExec)(["sh", "-c", check], {
			cwd,
			env: sessionEnv(process.env),
		});
		const output = `${r.stdout}${r.stderr}`;
		log.push(`$ ${check}\n${output}\nexit ${r.exitCode}\n`);
		if (r.exitCode) failed.push({ check, output: output.slice(-4000) });
	}
	writeFileSync(join(ctx.artifacts, `${name}.checks.log`), log.join("\n"));
	return failed;
}

function reviewBrief(failed: CheckFailure[]): string {
	return `A reviewer ran the repository's checks on your branch and is sending the work back, because these failed:

${failed.map((f) => `$ ${f.check}\n${f.output}`).join("\n\n")}

Fix the cause, commit on the current branch, and stop when every check passes.`;
}

/** What the scripted person says to a question no script covers, and how many a run may ask. */
export interface Unscripted {
	answer: string;
	max: number;
}

const UNSCRIPTED: Unscripted = {
	answer:
		"Take the option you recommend and carry on to the end without asking again.",
	max: 3,
};

/** The suite's `person.json` `unscripted` entry, or the default when it has none. */
export function unscripted(person: string): Unscripted {
	try {
		const u = JSON.parse(readFileSync(person, "utf8")).unscripted;
		return { ...UNSCRIPTED, ...u };
	} catch {
		return UNSCRIPTED;
	}
}

/** How a session puts something to the person besides a question mark: "tell me whether…". */
const ASKS =
	/\b(tell me|let me know|your call|your decision|your approval|your go-ahead|if you approve|confirm|which (?:option|one|should)|do you want|would you like|shall i|should i)\b/i;

/**
 * Whether a session ended by putting a question to the person instead of finishing: its
 * last paragraph asks one, with a question mark or a direct ask ("tell me whether I should…").
 * A headless session cannot wait for the answer, so without one the run simply stops there.
 */
export function asksThePerson(result: string): boolean {
	const paras = result.trim().split(/\n\s*\n/);
	// A direct ask can sit above a closing note ("I'd leave the profile unchanged."), so it counts
	// in the last few paragraphs; a question mark counts only in the last, since a summary may
	// quote an earlier question it already answered.
	const tail = paras.slice(-3).join("\n\n");
	return (paras.at(-1) ?? "").includes("?") || ASKS.test(tail);
}

/** Sessions run one after another as one: their tokens, cost and minutes summed, the last one's outcome. */
export function combined(rounds: Session[]): Session {
	const last = rounds.at(-1) as Session;
	const sum = (f: (s: Session) => number) =>
		rounds.reduce((a, s) => a + f(s), 0);
	const tokensByModel: Record<string, number> = {};
	for (const s of rounds)
		for (const [m, n] of Object.entries(s.tokensByModel))
			tokensByModel[m] = (tokensByModel[m] ?? 0) + n;
	return {
		...last,
		tokens: sum((s) => s.tokens),
		tokensByModel,
		usd: rounds.every((s) => s.usd !== undefined)
			? sum((s) => s.usd ?? 0)
			: undefined,
		minutes: sum((s) => s.minutes),
	};
}

/**
 * A session, resumed with the scripted person's unscripted answer each time it stops on a
 * question, up to the person's limit and within the session's spend cap and time. The same
 * for every arm that converses, so asking costs a decision rather than ending the run.
 */
export async function answeredSession(
	ctx: ArmContext,
	o: Parameters<typeof claudeSession>[1],
): Promise<{ session: Session; answers: number }> {
	const started = new Date();
	const person = unscripted(ctx.person);
	const rounds = [await claudeSession(ctx, o)];
	for (;;) {
		const s = rounds.at(-1) as Session;
		const answers = rounds.length - 1;
		if (s.stoppedBy || !asksThePerson(s.result) || answers >= person.max) break;
		const spent = rounds.reduce((a, r) => a + (r.usd ?? 0), 0);
		const usd =
			(o.usd ?? ctx.limits.usd) === undefined
				? undefined
				: ((o.usd ?? ctx.limits.usd) as number) - spent;
		if (usd !== undefined && usd <= 0) break;
		ctx.log(
			`${o.name}: asked the person; answering (${answers + 1} of ${person.max})`,
		);
		rounds.push(
			await claudeSession(ctx, {
				...o,
				name: `${o.name}-answer-${answers + 1}`,
				prompt: person.answer,
				resume: s.sessionId,
				usd,
				minutes:
					(o.minutes ?? ctx.limits.minutes) -
					minutesBetween(started, new Date()),
			}),
		);
	}
	return { session: combined(rounds), answers: rounds.length - 1 };
}

/**
 * A baseline's first attempt and its review rounds: after each session the scripted
 * reviewer runs the repo's checks, and while any fail the session is resumed with the
 * failures, up to the suite's `reviews` rounds and within the run's spend cap and time.
 * Each round after the first is rework. Each review of the diff is a decision, the one that
 * passes included, as Portia's sign-off on its diff is; starting the session is not, for
 * any arm.
 */
export async function reviewedSession(
	ctx: ArmContext,
	o: { cwd: string; prompt: string; name: string },
): Promise<{
	session: Session;
	rework: Scores["rework"];
	/** Reviews of the diff: one per round the reviewer got to. */
	decisions: number;
}> {
	const started = new Date();
	const rounds: Session[] = [];
	let reviews = 0;
	let answered = 0;
	let prompt = o.prompt;
	for (;;) {
		const spent = rounds.reduce((a, s) => a + (s.usd ?? 0), 0);
		const usd =
			ctx.limits.usd !== undefined ? ctx.limits.usd - spent : undefined;
		const name = rounds.length ? `${o.name}-review-${rounds.length}` : o.name;
		const { session: s, answers } = await answeredSession(ctx, {
			cwd: o.cwd,
			prompt,
			name,
			resume: rounds.at(-1)?.sessionId,
			usd,
			minutes: ctx.limits.minutes - minutesBetween(started, new Date()),
		});
		answered += answers;
		rounds.push(s);
		if (s.stoppedBy) break;
		const failed = await runChecks(ctx, o.cwd, name);
		reviews++;
		if (!failed.length) break;
		ctx.log(
			`${name}: ${failed.map((f) => f.check).join(", ")} failed after round ${rounds.length}`,
		);
		if (rounds.length > ctx.limits.reviews) break;
		if (usd !== undefined && usd - (s.usd ?? 0) <= 0) {
			s.stoppedBy = "budget";
			break;
		}
		prompt = reviewBrief(failed);
	}
	return reviewed(rounds, reviews + answered);
}

/** Review rounds as one session: every round after the first is rework. */
function reviewed(
	rounds: Session[],
	decisions: number,
): Awaited<ReturnType<typeof reviewedSession>> {
	const later = rounds.slice(1);
	const sum = (xs: Session[], f: (s: Session) => number) =>
		xs.reduce((a, s) => a + f(s), 0);
	const session = combined(rounds);
	const { tokens, minutes } = session;
	return {
		session,
		rework: {
			retries: later.length,
			failedLands: 0,
			tokenShare: tokens ? sum(later, (s) => s.tokens) / tokens : 0,
			minuteShare: minutes ? sum(later, (s) => s.minutes) / minutes : 0,
		},
		decisions,
	};
}

/**
 * `reviewedSession` as its transcripts kept it: `<name>.json`, then each
 * `<name>-review-<k>.json`, each with its answers. A round the reviewer got to left its
 * `<round>.checks.log`, so the decisions are those reviews plus the answers. A round the
 * harness stopped for the spend cap after its review reads as unstopped. Undefined when
 * there is no transcript.
 */
export function savedReviewedSession(
	artifacts: string,
	name: string,
	limitMinutes?: number,
): Awaited<ReturnType<typeof reviewedSession>> | undefined {
	const rounds: Session[] = [];
	let decisions = 0;
	for (let k = 0; ; k++) {
		const round = k ? `${name}-review-${k}` : name;
		const s = savedAnsweredSession(artifacts, round, limitMinutes);
		if (!s) break;
		rounds.push(s.session);
		decisions += s.answers;
		if (existsSync(join(artifacts, `${round}.checks.log`))) decisions++;
	}
	return rounds.length ? reviewed(rounds, decisions) : undefined;
}
