import { spawn } from "node:child_process";
import { PortiaProblem } from "./exit";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	/** Set when `timeoutMs` ran out and the command's process group was killed. */
	timedOut?: boolean;
}
export interface ExecOpts {
	cwd?: string;
	env?: Record<string, string>;
	input?: string;
	/** Kill the command (and anything it started) after this long; it then exits 124. */
	timeoutMs?: number;
	/**
	 * Keep only about this many trailing characters of stdout and of stderr, for a
	 * command whose output only matters for its last lines (a gate step, a review).
	 */
	keepTail?: number;
}
export type Exec = (
	cmd: string,
	args: string[],
	opts?: ExecOpts,
) => Promise<ExecResult>;

const killGroup = (pid: number) => {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {}
};

/**
 * Timed commands still running. A detached group is out of reach of a Ctrl-C or of the
 * session ending, so while any runs Portia kills them on its own exit or on SIGINT and
 * SIGTERM, then lets the signal take its default course.
 */
const groups = new Set<number>();
const onExit = () => {
	for (const pid of groups) killGroup(pid);
};
const onSignal = (sig: NodeJS.Signals) => {
	onExit();
	groups.clear();
	unlisten();
	process.kill(process.pid, sig);
};
function unlisten() {
	process.off("exit", onExit);
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
}
function watch(pid: number) {
	if (groups.size === 0) {
		process.on("exit", onExit);
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
	}
	groups.add(pid);
}
function unwatch(pid: number) {
	if (groups.delete(pid) && groups.size === 0) unlisten();
}

export const spawnExec: Exec = (cmd, args, opts = {}) =>
	new Promise((resolve, reject) => {
		// A timed command leads its own process group, so a kill reaches what `sh -c` started.
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			detached: opts.timeoutMs !== undefined,
		});
		const group = opts.timeoutMs !== undefined ? child.pid : undefined;
		if (group !== undefined) watch(group);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer =
			opts.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						if (group !== undefined) killGroup(group);
						else child.kill("SIGKILL");
					}, opts.timeoutMs);
		// Trimmed only once the buffer is twice the cap, so trimming stays cheap.
		const keep = opts.keepTail;
		const bound = (s: string) =>
			keep !== undefined && s.length > keep * 2 ? s.slice(-keep) : s;
		const trim = (s: string) =>
			keep !== undefined && s.length > keep ? s.slice(-keep) : s;
		child.stdout.on("data", (d) => {
			stdout = bound(stdout + d);
		});
		child.stderr.on("data", (d) => {
			stderr = bound(stderr + d);
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			if (group !== undefined) unwatch(group);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (group !== undefined) unwatch(group);
			stdout = trim(stdout);
			stderr = trim(stderr);
			resolve(
				timedOut
					? {
							code: 124,
							stdout,
							stderr: `${stderr}\ntimed out after ${opts.timeoutMs}ms`,
							timedOut,
						}
					: { code: code ?? 1, stdout, stderr },
			);
		});
		// A child that exits without reading stdin closes the pipe first; the write's EPIPE
		// is not a failure of the command, whose exit code `close` already reports.
		child.stdin.on("error", () => {});
		child.stdin.end(opts.input ?? "");
	});

export const isDryRun = () => process.env.PORTIA_DRY_RUN === "1";

const MUTATING: [string, RegExp][] = [
	["git", /^(push|commit|rebase|merge|reset|worktree)$/],
	["gh", /^pr$/],
	["createdb", /./],
	["dropdb", /./],
	["docker", /./],
	["sh", /./],
	["bun", /^install$/],
];
const GH_READS = new Set(["list", "view", "checks"]);
const isRead = (cmd: string, args: string[]) =>
	(cmd === "gh" && GH_READS.has(args[1] ?? "")) ||
	(cmd === "git" && args[0] === "worktree" && args[1] === "list");

/**
 * `gh api` reads by default and writes when it carries a non-GET method, or
 * fields/input without an explicit GET (gh then defaults to POST).
 */
// `gh api graphql -f query=...` counts as a write (the safe direction); nothing uses graphql today.
function ghApiMutates(args: string[]): boolean {
	let method: string | undefined;
	let hasBody = false;
	for (let i = 1; i < args.length; i++) {
		const a = args[i] ?? "";
		if (a === "-X" || a === "--method") method = args[++i];
		else if (a.startsWith("--method=")) method = a.slice(9);
		else if (a.startsWith("-X") && a.length > 2) method = a.slice(2);
		else if (/^(-f|-F)/.test(a) || /^--(field|raw-field|input)(=|$)/.test(a))
			hasBody = true;
	}
	if (method !== undefined) return method.toUpperCase() !== "GET";
	return hasBody;
}

const isMutating = (cmd: string, args: string[]) =>
	cmd === "gh" && args[0] === "api"
		? ghApiMutates(args)
		: MUTATING.some(([c, r]) => c === cmd && r.test(args[0] ?? "")) &&
			!isRead(cmd, args);

export function dryRun(
	inner: Exec,
	log: (s: string) => void = (s) => console.error(s),
): Exec {
	return async (cmd, args, opts) => {
		if (!isMutating(cmd, args)) return inner(cmd, args, opts);
		log(`[dry-run] ${cmd} ${args.join(" ")}`);
		return {
			code: 0,
			stdout:
				cmd === "gh" && args[1] === "create"
					? "https://github.com/dry/run/pull/1\n"
					: "",
			stderr: "",
		};
	};
}

let spawner: Exec = spawnExec;
/**
 * Test seam: the process spawner under `realExec`. The end-to-end suite swaps in one that
 * emulates `gh pr` locally. Returns a function that restores the previous spawner.
 */
export function useSpawner(e: Exec): () => void {
	const prev = spawner;
	spawner = e;
	return () => {
		spawner = prev;
	};
}

/**
 * How long a network command may run before it is killed and counts as a transient failure.
 * A push runs the repo's pre-push hooks inside that limit, so it gets far longer, and a push
 * killed at it is not run again: the hooks would only run as long a second time.
 */
export const NET_TIMEOUT_MS = {
	gh: 2 * 60_000,
	git: 5 * 60_000,
	push: 30 * 60_000,
};

/**
 * A network command that is safe to run again: a GitHub read, a fetch or ls-remote, or a
 * push of a named commit (pushing it twice leaves the remote as one push would). Writes
 * whose repeat would act twice (`gh pr merge`, `gh pr create`, a `gh api` POST) never are.
 */
export function idempotentNet(cmd: string, args: string[]): boolean {
	if (cmd === "gh")
		return args[0] === "api"
			? !ghApiMutates(args)
			: args[0] === "pr" && GH_READS.has(args[1] ?? "");
	if (cmd !== "git") return false;
	if (args[0] === "fetch" || args[0] === "ls-remote") return true;
	return (
		args[0] === "push" &&
		!args.some((a) => a === "--delete" || a === "-d" || a.startsWith(":"))
	);
}

/** Failures worth another try: the network or the server, never the request itself. */
const TRANSIENT =
	/timed out|timeout|HTTP (429|5\d\d)|returned error: (429|5\d\d)|rate limit|connection (reset|refused|closed|timed)|could not resolve host|temporary failure|unexpected disconnect|early EOF|remote end hung up|network is unreachable|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TLS handshake|SSL_ERROR/i;
export const transientFailure = (r: ExecResult) =>
	r.code !== 0 && (r.timedOut === true || TRANSIENT.test(r.stderr));

/**
 * Git failing on a ref's lock. Every worktree shares one ref store, so a fetch elsewhere (a
 * land, an env, a sync, the epic gate) may hold or have just moved the ref this one updates.
 */
export const REF_LOCKED =
	/cannot lock ref|unable to update local ref|Unable to create '[^']*\.lock'/i;
const isPush = (cmd: string, args: string[]) =>
	cmd === "git" && args[0] === "push";
/**
 * A fetch that lost a race for a remote-tracking ref only needs running again, and so does
 * a read of an issue's dependencies that answered 404: GitHub briefly reports them not
 * found for an issue that has them (ACME-500 run 12). Any other 404 means the thing is
 * absent, which callers test for, so it fails at once. Only reads reach here (idempotentNet).
 */
const retryable = (cmd: string, args: string[], r: ExecResult) =>
	(transientFailure(r) && !(isPush(cmd, args) && r.timedOut)) ||
	(cmd === "git" &&
		args[0] === "fetch" &&
		r.code !== 0 &&
		REF_LOCKED.test(r.stderr)) ||
	(cmd === "gh" &&
		args[0] === "api" &&
		/\/dependencies\//.test(args[1] ?? "") &&
		r.code !== 0 &&
		/\(HTTP 404\)/.test(r.stderr));

export interface RetryOpts {
	/** Runs in all, the first included. */
	attempts?: number;
	/** The wait before the second run; it doubles before each later one. */
	backoffMs?: number;
	sleep?: (ms: number) => Promise<void>;
	log?: (s: string) => void;
}

/**
 * Bounds and retries the network commands that are safe to repeat (see idempotentNet):
 * each gets a timeout unless the caller set one, so a hung connection never holds a lock
 * for good, and a transient failure (or a fetch that lost a ref-lock race) is retried with
 * exponential backoff. Every other
 * command passes through untouched.
 */
export function withNetRetry(inner: Exec, o: RetryOpts = {}): Exec {
	const attempts = o.attempts ?? 3;
	const backoffMs = o.backoffMs ?? 1_000;
	const sleep =
		o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const log = o.log ?? ((s: string) => console.error(s));
	return async (cmd, args, opts = {}) => {
		if (!idempotentNet(cmd, args)) return inner(cmd, args, opts);
		const timed = {
			...opts,
			timeoutMs:
				opts.timeoutMs ??
				NET_TIMEOUT_MS[
					isPush(cmd, args) ? "push" : (cmd as keyof typeof NET_TIMEOUT_MS)
				],
		};
		let r = await inner(cmd, args, timed);
		for (let n = 1; n < attempts && retryable(cmd, args, r); n++) {
			const wait = backoffMs * 2 ** (n - 1);
			log(
				`${cmd} ${args.slice(0, 2).join(" ")} failed (${r.timedOut ? "timed out" : r.code}); trying again in ${wait / 1000}s`,
			);
			await sleep(wait);
			r = await inner(cmd, args, timed);
		}
		return r;
	};
}

export const realExec: Exec = (cmd, args, opts) =>
	withNetRetry(isDryRun() ? dryRun(spawner) : spawner)(cmd, args, opts);

export async function must(
	exec: Exec,
	cmd: string,
	args: string[],
	opts?: ExecOpts,
): Promise<string> {
	const r = await exec(cmd, args, opts);
	if (r.code !== 0) {
		throw new PortiaProblem(
			`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr.trim().slice(-500)}`,
		);
	}
	return r.stdout;
}
