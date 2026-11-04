import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	linkSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PortiaProblem } from "../core/exit";
import { pidAlive as alive } from "../core/process";

// Every lock this process holds, by absolute path; a lock is created and added here in one step.
const held = new Set<string>();
const holding = new AsyncLocalStorage<Set<string>>();

/** An unreadable lock this old is a holder that died mid-write, not one still writing. */
const UNREADABLE_STALE_MS = 10_000;

type Owner = { pid: number; proc?: string; nonce?: string };

/** A process's start time, so a pid reused by another process is not taken for the holder. */
function startTime(pid: number): string | undefined {
	try {
		return (
			execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				timeout: 2_000,
				stdio: ["ignore", "pipe", "ignore"],
				// Pinned, so a holder and a waiter run with different zones still agree on it.
				env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}
let self: string | undefined;
const selfStart = () => {
	self ??= startTime(process.pid) ?? "";
	return self || undefined;
};

/** The holder a lock file names: JSON from this module, or a bare pid from older versions. */
function parse(text: string): Owner | undefined {
	try {
		const o = JSON.parse(text) as Owner;
		if (Number.isInteger(o?.pid) && o.pid > 0) return o;
	} catch {}
	const pid = Number(text.trim());
	return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
}

const read = (path: string) => {
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
};

// The last holder seen alive with a matching start time, and when. Its pid cannot be reused
// while it runs, but it may die without releasing, so the start time is checked again after
// VERIFIED_MS rather than trusted for good.
let verified: { text: string; at: number } | undefined;
const VERIFIED_MS = 30_000;

/** Whether the lock holding `text` belongs to no live process, so it may be taken over. */
function stale(path: string, text: string): boolean {
	const o = parse(text);
	if (!o) {
		try {
			return Date.now() - statSync(path).mtimeMs > UNREADABLE_STALE_MS;
		} catch {
			return false;
		}
	}
	// This process holds no lock outside `held`, so one naming its pid was left by an
	// earlier process that had the same pid (a restarted container's, say).
	if (o.pid === process.pid) return !held.has(resolve(path));
	if (!alive(o.pid)) return true;
	if (!o.proc) return false;
	if (verified?.text === text && Date.now() - verified.at < VERIFIED_MS)
		return false;
	const now = startTime(o.pid);
	if (now && now !== o.proc) {
		if (verified?.text === text) verified = undefined;
		return true;
	}
	verified = { text, at: Date.now() };
	return false;
}

/** Create the lock holding `token`, fully written before anyone can see it; false if it exists. */
function create(path: string, token: string): boolean {
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, token);
	try {
		linkSync(tmp, path);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		return false;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Remove a stale lock under a short-lived guard, so exactly one waiter removes it. Nothing else
 * can change the file while the guard is held: its dead holder will not release it, a creator
 * fails on the existing file, and every other remover needs the guard. Moving it aside instead
 * cannot be undone safely, since a lock taken in between leaves nowhere to put a live one back.
 */
function takeOver(path: string, text: string, token: string): boolean {
	const guard = `${path}.steal`;
	if (!create(guard, token)) {
		// A guard is held for microseconds, so one whose holder is gone was left by a crash.
		const g = read(guard);
		if (g !== undefined && stale(guard, g) && read(guard) === g)
			rmSync(guard, { force: true });
		return false;
	}
	try {
		if (read(path) !== text) return false;
		rmSync(path, { force: true });
		return true;
	} finally {
		rmSync(guard, { force: true });
	}
}

/** The token this process writes into `path` when it takes it, or undefined while another holds it. */
function tryTake(path: string): string | undefined {
	if (held.has(resolve(path))) return undefined;
	const token = JSON.stringify({
		pid: process.pid,
		proc: selfStart(),
		nonce: randomBytes(8).toString("hex"),
	});
	for (let i = 0; i < 2; i++) {
		if (create(path, token)) {
			held.add(resolve(path));
			return token;
		}
		const text = read(path);
		if (text === undefined) continue;
		if (!stale(path, text) || !takeOver(path, text, token)) return undefined;
	}
	return undefined;
}

/** The pid of the live process holding the lock `name` in `dir`, if one does. */
export function lockHolder(dir: string, name: string): number | undefined {
	const path = join(dir, name);
	const text = read(path);
	if (text === undefined || stale(path, text)) return undefined;
	return parse(text)?.pid;
}

/** Remove the lock only while it still holds our token, never a later holder's. */
function release(path: string, token: string) {
	held.delete(resolve(path));
	if (read(path) === token) rmSync(path, { force: true });
}

// A detached worker sets this, so its stall check sees it waiting its turn rather than idle.
const HEARTBEAT_MS = 10_000;
function heartbeat(last: number): number {
	const file = process.env.PORTIA_WAIT_FILE;
	if (!file || Date.now() - last < HEARTBEAT_MS) return last;
	try {
		writeFileSync(file, new Date().toISOString());
	} catch {}
	return Date.now();
}

type LockOpts = {
	timeoutMs?: number;
	pollMs?: number;
	name?: string;
	/** The message for a timeout; it names the lock by default. */
	problem?: string;
};
const timedOut = (path: string, opts: LockOpts) =>
	new PortiaProblem(
		opts.problem ?? `timed out waiting for the lock at ${path}`,
	);
/** A poll interval with jitter, so waiters released together do not retry in step. */
const jittered = (ms: number) => Math.round(ms * (0.5 + Math.random()));

/**
 * One holder at a time per named lock (default: the heavy-check lock shared by every worker
 * and the orchestrator). Landings use their own `land.lock` so they never starve heavy steps.
 * A lock whose holder has died (its pid is gone, or now names a process started at another
 * time) is taken over atomically, and a holder only ever removes its own lock.
 */
export async function withLock<T>(
	dir: string,
	fn: () => Promise<T>,
	opts: LockOpts = {},
): Promise<T> {
	const path = join(dir, opts.name ?? "heavy.lock");
	if (holding.getStore()?.has(path)) return fn();
	const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
	let token = tryTake(path);
	let beat = 0;
	while (token === undefined) {
		if (Date.now() > deadline) throw timedOut(path, opts);
		beat = heartbeat(beat);
		await new Promise((r) => setTimeout(r, jittered(opts.pollMs ?? 250)));
		token = tryTake(path);
	}
	try {
		return await holding.run(
			new Set([...(holding.getStore() ?? []), path]),
			fn,
		);
	} finally {
		release(path, token);
	}
}

/** `withLock` for a short synchronous critical section; it blocks the thread while it waits. */
export function withLockSync<T>(
	dir: string,
	fn: () => T,
	opts: LockOpts & { name: string },
): T {
	const path = join(dir, opts.name);
	const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
	let token = tryTake(path);
	while (token === undefined) {
		if (Date.now() >= deadline) throw timedOut(path, opts);
		Atomics.wait(
			new Int32Array(new SharedArrayBuffer(4)),
			0,
			0,
			jittered(opts.pollMs ?? 25),
		);
		token = tryTake(path);
	}
	try {
		return fn();
	} finally {
		release(path, token);
	}
}
