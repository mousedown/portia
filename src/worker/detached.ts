import { execFileSync, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type Account,
	DEFAULT_ACCOUNT,
	markLimited,
	markNotLoggedIn,
} from "../core/accounts";
import { writeFileAtomic } from "../core/atomic";
import type { Profile } from "../core/config";
import type { Exec } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import { mergeDenies } from "../core/permissions";
import type { RunRow } from "../core/types";
import { type ParseOutcome, parseResult } from "../result/parse";
import { roleTools, toolArgs, type WorkerRole } from "./tools";
import {
	NOT_LOGGED_IN,
	notLoggedIn,
	USAGE_LIMIT,
	usageLimit,
} from "./usage-limit";

export interface WorkerRecord {
	child: string;
	attempt: number;
	pid: number;
	/** The process's start time when it was launched, so a reused pid is not taken for it. */
	proc?: string;
	worktree: string;
	log: string;
	result: string;
	startedAt: string;
	/** The Claude login it runs under; absent, the CLI's own. */
	account?: string;
}
export type Probe =
	| { state: "alive" }
	| { state: "finished" }
	| { state: "stalled"; reason: string };

/** Process control for detached workers; tests swap in scripted processes. */
export interface Procs {
	start(
		cmd: string,
		args: string[],
		o: {
			cwd: string;
			stdin: string;
			log: string;
			/** Added to the orchestrator's environment; an undefined value removes the variable. */
			env?: Record<string, string | undefined>;
		},
	): number;
	alive(pid: number): boolean;
	/** Stops the worker's process group and resolves once it is gone. */
	stop(pid: number): void | Promise<void>;
	/** What identifies the process behind a pid: its start time. */
	identity?(pid: number): string | undefined;
	/** CPU seconds used by the worker and every process under it. */
	cpu?(pid: number): number | undefined;
}

const signal = (pid: number, sig: NodeJS.Signals | 0) => {
	try {
		process.kill(pid, sig);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ps = (args: string[]) => {
	try {
		return execFileSync("ps", args, { encoding: "utf8" });
	} catch {
		return undefined;
	}
};

/** `[dd-][hh:]mm:ss[.cc]` as seconds. */
const cpuSeconds = (t: string) => {
	const [days, clock] = t.includes("-") ? t.split("-") : ["0", t];
	return (
		Number(days) * 86_400 +
		(clock ?? "").split(":").reduce((s, part) => s * 60 + Number(part), 0)
	);
};

/** CPU seconds of `pid`, its process group and its descendants, from `ps -A -o pid=,ppid=,pgid=,time=`. */
export function treeCpu(out: string, pid: number): number | undefined {
	const rows = out
		.split("\n")
		.map((l) => l.trim().split(/\s+/))
		.filter((f) => f.length === 4)
		.map(([p, pp, pg, t]) => ({
			pid: Number(p),
			ppid: Number(pp),
			pgid: Number(pg),
			cpu: cpuSeconds(t ?? ""),
		}));
	if (!rows.some((r) => r.pid === pid)) return undefined;
	const tree = new Set([pid]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const r of rows)
			if (!tree.has(r.pid) && (r.pgid === pid || tree.has(r.ppid))) {
				tree.add(r.pid);
				grew = true;
			}
	}
	return rows
		.filter((r) => tree.has(r.pid))
		.reduce((s, r) => s + (r.cpu || 0), 0);
}

/**
 * A login a worker started under the CLI's own account can use when there is no stored one:
 * the token in the file `PORTIA_WORKER_TOKEN_FILE` names, as `CLAUDE_CODE_OAUTH_TOKEN`. Claude
 * Code strips that variable from the commands its shell tool runs, so a worker started from an
 * orchestrator session never inherits it; a path to a file does survive.
 */
export function tokenFromFile(
	env: Record<string, string | undefined> = process.env,
): { CLAUDE_CODE_OAUTH_TOKEN?: string } {
	const file = env.PORTIA_WORKER_TOKEN_FILE;
	if (!file || !existsSync(file)) return {};
	const token = readFileSync(file, "utf8").trim();
	return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}

/**
 * Run by the launcher: spawns the worker as its own session and group leader, prints its
 * pid and exits, so the worker is reparented away from whoever started it. Plain JS, for
 * `bun -e` and `node -e` alike.
 */
const LAUNCHER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
	const o = JSON.parse(s);
	const stdin = fs.openSync(o.stdin, "r");
	const out = fs.openSync(o.log, "a");
	const child = spawn(o.cmd, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: [stdin, out, out] });
	child.on("error", () => {});
	if (!child.pid) process.exit(1);
	child.unref();
	process.stdout.write(String(child.pid));
	process.exit(0);
});
`;

export const realProcs: Procs = {
	// Started through a launcher that exits at once, so the worker is no child of this process:
	// a tree kill of a timed-out `portia drive` (the Bash tool's background limit walks
	// children by parent pid) leaves the workers it started running, as a stop does.
	start(cmd, args, o) {
		// A worker started from inside a Claude Code session must not look nested to it.
		const { CLAUDECODE: _, ...env } = process.env;
		const spec = {
			cmd,
			args,
			cwd: o.cwd,
			stdin: o.stdin,
			log: o.log,
			env: Object.fromEntries(
				Object.entries({ ...env, ...o.env }).filter(([, v]) => v !== undefined),
			),
		};
		const r = spawnSync(process.execPath, ["-e", LAUNCHER], {
			input: JSON.stringify(spec),
			encoding: "utf8",
			timeout: 30_000,
		});
		const pid = Number(r.stdout?.trim());
		if (r.status !== 0 || !Number.isInteger(pid) || pid <= 0)
			throw new PortiaProblem(
				`could not start ${cmd}${r.error ? `: ${r.error.message}` : ""}`,
			);
		return pid;
	},
	alive: (pid) => signal(pid, 0),
	// The worker leads its own process group, so its commands stop with it.
	async stop(pid) {
		for (const sig of ["SIGTERM", "SIGKILL"] as const) {
			if (!signal(-pid, sig)) signal(pid, sig);
			for (let i = 0; i < 50 && signal(pid, 0); i++) await sleep(100);
			if (!signal(pid, 0)) return;
		}
	},
	identity: (pid) =>
		ps(["-o", "lstart=", "-p", String(pid)])?.trim() || undefined,
	cpu: (pid) => {
		const out = ps(["-A", "-o", "pid=,ppid=,pgid=,time="]);
		return out === undefined ? undefined : treeCpu(out, pid);
	},
};

let procs: Procs = realProcs;
/** Test seam: the process control every command uses. Returns a restore function. */
export function useProcs(p: Procs): () => void {
	const prev = procs;
	procs = p;
	return () => {
		procs = prev;
	};
}
export const currentProcs = () => procs;

export const workerPaths = (dir: string, key: string, attempt: number) => ({
	record: join(dir, `worker-${key}.json`),
	brief: join(dir, `brief-${key}-${attempt}.md`),
	log: join(dir, `worker-${key}-${attempt}.log`),
	result: join(dir, `result-${key}-${attempt}.json`),
	settings: join(dir, `worker-${key}-${attempt}.settings.json`),
	mcp: join(dir, `worker-${key}-${attempt}.mcp.json`),
	wait: join(dir, `worker-${key}-${attempt}.wait`),
});

/** The last detached worker started for `key`, whatever its attempt. */
export function readRecord(dir: string, key: string): WorkerRecord | undefined {
	const file = workerPaths(dir, key, 0).record;
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as WorkerRecord;
	} catch {
		throw new PortiaProblem(
			`the worker record ${file} is not valid JSON; check whether ${key}'s worker still runs, then remove it`,
		);
	}
}

/** The detached worker for `key`'s latest dispatched attempt, if one was started. */
export function readWorker(
	dir: string,
	key: string,
	rows: RunRow[],
): WorkerRecord | undefined {
	const attempt = rows
		.filter((r) => r.child === key && r.stage === "dispatched")
		.at(-1)?.attempt;
	const rec = readRecord(dir, key);
	return attempt !== undefined && rec?.attempt === attempt ? rec : undefined;
}

/** Whether the recorded worker still runs: its pid is alive and is still the same process. */
export function running(rec: WorkerRecord, p: Procs = procs): boolean {
	if (!p.alive(rec.pid)) return false;
	const id = rec.proc && p.identity?.(rec.pid);
	return !id || id === rec.proc;
}

export function startWorker(
	o: {
		dir: string;
		key: string;
		attempt: number;
		/** What the worker does, which decides the tools and MCP servers it loads. */
		role: WorkerRole;
		model: string;
		worktree: string;
		brief: string;
		workers: Profile["workers"];
		denyRules: string[];
		account?: Account;
	},
	p: Procs = procs,
	now = Date.now,
): WorkerRecord {
	const paths = workerPaths(o.dir, o.key, o.attempt);
	writeFileSync(paths.brief, o.brief);
	// The worker runs outside the orchestrator's session, so it carries the deny rules itself.
	writeFileSync(
		paths.settings,
		JSON.stringify(mergeDenies({}, o.denyRules), null, 2),
	);
	const { tools, mcpServers } = roleTools(o.workers, o.role);
	writeFileSync(paths.mcp, JSON.stringify({ mcpServers }, null, 2));
	rmSync(paths.result, { force: true });
	const pid = p.start(
		o.workers.command,
		[
			...o.workers.args,
			"--settings",
			paths.settings,
			"--add-dir",
			o.dir,
			...toolArgs(tools, paths.mcp),
			"-p",
			"--model",
			o.model,
		],
		// Its portia commands touch this file while they wait on a lock, which counts as progress.
		{
			cwd: o.worktree,
			stdin: paths.brief,
			log: paths.log,
			env: {
				PORTIA_WAIT_FILE: paths.wait,
				// The default login is stored for an unset CLAUDE_CONFIG_DIR, even one naming ~/.claude.
				...(o.account?.configDir
					? { CLAUDE_CONFIG_DIR: o.account.configDir }
					: o.account?.defaultLogin
						? { CLAUDE_CONFIG_DIR: undefined }
						: {}),
				...(o.account?.configDir ? {} : tokenFromFile()),
			},
		},
	);
	const rec: WorkerRecord = {
		child: o.key,
		attempt: o.attempt,
		pid,
		worktree: o.worktree,
		log: paths.log,
		result: paths.result,
		startedAt: new Date(now()).toISOString(),
		...(o.account ? { account: o.account.name } : {}),
	};
	// Recorded before anything else can fail, so a worker is never left running unrecorded;
	// the process identity, which costs a ps call, is added after.
	writeFileAtomic(paths.record, JSON.stringify(rec));
	const proc = p.identity?.(pid);
	if (proc === undefined) return rec;
	const full = { ...rec, proc };
	writeFileAtomic(paths.record, JSON.stringify(full));
	return full;
}

const mtime = (f: string) => {
	try {
		return statSync(f).mtimeMs;
	} catch {
		return 0;
	}
};

/** The CPU share of wall time that counts as busy, and the shortest interval it is measured over. */
const BUSY = 0.05;
const SAMPLE_MS = 10_000;

/** When the worker's process tree was last seen busy, from CPU samples kept beside its log. */
function cpuProgress(rec: WorkerRecord, p: Procs, now: number): number {
	if (!p.cpu) return 0;
	const file = rec.log.replace(/\.log$/, ".cpu.json");
	let prev: { cpu: number; seen: number; at: number } | undefined;
	try {
		prev = JSON.parse(readFileSync(file, "utf8"));
	} catch {}
	// A recent sample stands, so the process table is not read again for it.
	if (prev && now - prev.seen < SAMPLE_MS) return prev.at;
	const cpu = p.cpu(rec.pid);
	if (cpu === undefined) return 0;
	const busy = prev && (cpu - prev.cpu) * 1000 >= BUSY * (now - prev.seen);
	const at = busy ? now : (prev?.at ?? Date.parse(rec.startedAt));
	writeFileAtomic(file, JSON.stringify({ cpu, seen: now, at }));
	return at;
}

/**
 * The latest sign of work: the start, the log, the last commit, a changed file or a busy process.
 * The worktree is only looked at when the cheaper signs are `enough` ms old.
 */
async function lastProgress(
	rec: WorkerRecord,
	exec: Exec,
	p: Procs,
	now: number,
	enough: number,
): Promise<number> {
	const times = [
		Date.parse(rec.startedAt),
		mtime(rec.log),
		mtime(rec.log.replace(/\.log$/, ".wait")),
		cpuProgress(rec, p, now),
	];
	if (now - Math.max(...times) < enough) return Math.max(...times);
	// A removed worktree shows no progress rather than failing the probe.
	const git = (args: string[]) =>
		exec("git", args, { cwd: rec.worktree }).catch(() => ({
			code: 1,
			stdout: "",
			stderr: "",
		}));
	const [head, dirty] = await Promise.all([
		git(["log", "-1", "--format=%ct"]),
		git(["status", "--porcelain", "--untracked-files=all"]),
	]);
	if (head.code === 0) times.push(Number(head.stdout.trim()) * 1000 || 0);
	if (dirty.code === 0)
		for (const line of dirty.stdout.split("\n").filter(Boolean))
			times.push(
				mtime(join(rec.worktree, line.slice(3).split(" -> ").at(-1) ?? "")),
			);
	return Math.max(...times);
}

type LogResult = {
	type?: string;
	result?: unknown;
	usage?: Record<string, unknown>;
};
const resultLine = (line: string): LogResult | undefined => {
	if (!line.includes('"result"')) return undefined;
	try {
		const r = JSON.parse(line) as LogResult;
		return r.type === "result" ? r : undefined;
	} catch {
		return undefined;
	}
};
const TAIL = 64 * 1024;

/**
 * The last `result` line of a stream-json or json log. It is read from the end, in a
 * window that doubles until it holds that line, since the line carries the whole final
 * message; a log without one is read whole.
 */
function logResult(log: string): LogResult | undefined {
	let fd: number;
	try {
		fd = openSync(log, "r");
	} catch {
		return undefined;
	}
	try {
		const size = fstatSync(fd).size;
		for (let window = TAIL; ; window *= 2) {
			const from = Math.max(0, size - window);
			const buf = Buffer.alloc(size - from);
			readSync(fd, buf, 0, buf.length, from);
			const lines = buf.toString("utf8").split("\n");
			// The window's first line is cut short unless the window starts the file.
			for (let i = lines.length - 1; i >= (from > 0 ? 1 : 0); i--) {
				const r = resultLine(lines[i] ?? "");
				if (r) return r;
			}
			if (from === 0) return undefined;
		}
	} finally {
		closeSync(fd);
	}
}

/** The worker's final message: its result file, else the text of the log's `result` line. */
function finalText(rec: WorkerRecord): string | undefined {
	if (existsSync(rec.result)) return readFileSync(rec.result, "utf8");
	const r = logResult(rec.log)?.result;
	return typeof r === "string" ? r : undefined;
}

type ProbeCtx = {
	exec: Exec;
	stallMin: number;
	procs?: Procs;
	now?: () => number;
	/** Minutes an account rests after a usage limit that names no reset time. */
	limitCooldownMin?: number;
	/** Where the shared account state lives; the Portia home by default. */
	home?: string;
	/** The profile's accounts, to name a logged-out one's config dir. */
	accounts?: Account[];
};

export async function probe(rec: WorkerRecord, ctx: ProbeCtx): Promise<Probe> {
	const p = ctx.procs ?? procs;
	// The final message is only looked for once the worker has exited or gone quiet.
	if (!running(rec, p))
		return finalText(rec) !== undefined
			? { state: "finished" }
			: {
					state: "stalled",
					reason: "the worker exited without writing its result",
				};
	const now = (ctx.now ?? Date.now)();
	const window = ctx.stallMin * 60_000;
	const quiet = now - (await lastProgress(rec, ctx.exec, p, now, window));
	if (quiet < window) return { state: "alive" };
	return finalText(rec) !== undefined
		? { state: "finished" }
		: {
				state: "stalled",
				reason: `no log output, worktree change or busy process for ${Math.floor(quiet / 60_000)} min`,
			};
}

const usageTokens = (usage: Record<string, unknown>) =>
	[
		"input_tokens",
		"output_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
	].reduce((s, k) => s + (Number(usage[k]) || 0), 0);

/**
 * Total tokens from the last `result` line of a stream-json or json log. A worker that
 * never wrote one (stopped, crashed or killed) counts the usage of each assistant message
 * it logged instead; 0 when there is none.
 */
export function logTokens(log: string): number {
	const usage = logResult(log)?.usage;
	if (usage) return usageTokens(usage);
	if (!existsSync(log)) return 0;
	// stream-json repeats a message's usage on each of its content blocks; the last counts.
	const byMessage = new Map<string, number>();
	let unnamed = 0;
	for (const line of readFileSync(log, "utf8").split("\n")) {
		if (!line.includes('"usage"')) continue;
		try {
			const e = JSON.parse(line) as {
				type?: string;
				message?: { id?: unknown; usage?: Record<string, unknown> };
			};
			const u = e.type === "assistant" ? e.message?.usage : undefined;
			if (!u) continue;
			if (typeof e.message?.id === "string")
				byMessage.set(e.message.id, usageTokens(u));
			else unnamed += usageTokens(u);
		} catch {}
	}
	return [...byMessage.values()].reduce((s, n) => s + n, unnamed);
}

/**
 * A finished or stalled worker's outcome, after stopping its process if it still runs;
 * undefined while it is alive. A stall is a failed outcome naming the reason. A failure
 * that ends on the account's usage limit benches that account until it resets, and its
 * reason starts with `usage-limit:` so the retry goes to another account; one that ends
 * on the account not being logged in benches it until cleared, starting `not-logged-in:`.
 * `seen` reuses a probe the caller already made.
 */
export async function collect(
	rec: WorkerRecord,
	ctx: ProbeCtx,
	seen?: Probe,
): Promise<
	{ probe: Probe; outcome: ParseOutcome; tokens: number } | undefined
> {
	const p = ctx.procs ?? procs;
	const state = seen ?? (await probe(rec, { ...ctx, procs: p }));
	if (state.state === "alive") return undefined;
	if (running(rec, p)) await p.stop(rec.pid);
	const text = state.state === "finished" ? finalText(rec) : undefined;
	let outcome: ParseOutcome =
		text === undefined
			? {
					ok: false,
					error: `stalled: ${state.state === "stalled" ? state.reason : "the worker exited without writing its result"}`,
				}
			: parseResult(text, rec.child);
	if (!outcome.ok) {
		const now = (ctx.now ?? Date.now)();
		const account = rec.account ?? DEFAULT_ACCOUNT;
		const login = notLoggedIn(rec.log);
		const hit =
			login === undefined
				? usageLimit(rec.log, now, (ctx.limitCooldownMin ?? 60) * 60_000)
				: undefined;
		if (login !== undefined) {
			const a = ctx.accounts?.find((x) => x.name === account);
			const where = a?.configDir
				? `configDir ${a.configDir}`
				: a?.defaultLogin
					? "the default login"
					: "the CLI's own login";
			markNotLoggedIn(account, `${where}: ${login}`, { home: ctx.home, now });
			outcome = {
				ok: false,
				error: `${NOT_LOGGED_IN} account ${account} (${where}) is not logged in (${login}); log it in, then run portia accounts clear ${account}`,
			};
		} else if (hit) {
			markLimited(account, hit.until, hit.message, { home: ctx.home, now });
			outcome = {
				ok: false,
				error: `${USAGE_LIMIT} account ${account} is at its usage limit until ${new Date(hit.until).toISOString()} (${hit.message})`,
			};
		}
	}
	return { probe: state, outcome, tokens: logTokens(rec.log) };
}
