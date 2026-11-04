import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../core/atomic";
import { PortiaProblem } from "../core/exit";
import { pidAlive } from "../core/process";
import { LOG } from "../core/runlog";
import { withLockSync } from "../gate/lock";
import { MAX_AGE_MS } from "./slots";

/** A port handed out, and who holds it: the run and child it went to and the process that took it. */
export interface PortEntry {
	port: number;
	run: string;
	child: string;
	pid: number;
}

// One pool for every run on the machine, beside slots.lock, so two runs never hand out the same port.
const pool = (dir: string) => dirname(dir);
const file = (dir: string) => join(pool(dir), "ports.json");
const read = (dir: string): PortEntry[] => {
	if (!existsSync(file(dir))) return [];
	let all: unknown;
	try {
		all = JSON.parse(readFileSync(file(dir), "utf8"));
	} catch {
		// Unreadable, it holds nothing; the env state files still guard every port in use.
		return [];
	}
	return Array.isArray(all)
		? all.filter(
				(e): e is PortEntry =>
					typeof e?.port === "number" && typeof e?.run === "string",
			)
		: [];
};

/** The ports an env state file (env.ts writes one once a child's environment is up) records. */
const statePorts = (f: string): unknown[] => {
	try {
		const env = JSON.parse(readFileSync(f, "utf8"));
		return [env?.port, ...Object.values(env?.servicePorts ?? {})];
	} catch {
		return [];
	}
};
const mtime = (f: string): number => {
	try {
		return statSync(f).mtimeMs;
	} catch {
		return 0;
	}
};
/**
 * Whether an env state file still speaks for its ports. Only envDown removes one, and a child
 * parked, closed outside the run or abandoned never gets there, so another run's file that
 * neither it nor its run log has touched for a day is a leftover, not an env in use. This
 * run's own are always in use. A leftover's service still listening is passed over anyway,
 * as allocatePort never hands out a port that is not bindable.
 */
const current = (dir: string, run: string, f: string): boolean =>
	run === basename(dir) ||
	Date.now() - Math.max(mtime(f), mtime(join(pool(dir), run, LOG))) <
		MAX_AGE_MS;
const recorded = (dir: string, e: PortEntry): boolean => {
	const f = join(pool(dir), e.run, `env-${e.child}.json`);
	return (
		existsSync(f) && current(dir, e.run, f) && statePorts(f).includes(e.port)
	);
};
/**
 * Every port an environment that is up records, in any run, whether the pool lists it or
 * not: one handed out before the pool was machine-wide, or by a pool file lost since.
 */
function upPorts(dir: string): number[] {
	const out: number[] = [];
	const runs = pool(dir);
	for (const d of readdirSync(runs, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		let names: string[];
		try {
			names = readdirSync(join(runs, d.name));
		} catch {
			continue;
		}
		for (const n of names)
			if (
				/^env-.+\.json$/.test(n) &&
				current(dir, d.name, join(runs, d.name, n))
			)
				for (const p of statePorts(join(runs, d.name, n)))
					if (typeof p === "number") out.push(p);
	}
	return out;
}
/** Held while the process that took it still runs, or once an env state file records it. */
const held = (dir: string, e: PortEntry) =>
	(e.pid > 0 && pidAlive(e.pid)) || recorded(dir, e);

const lockFile = (dir: string) => join(pool(dir), "ports.lock");
const LOCK_WAIT_MS = 5000;

/** Run fn holding the machine's port pool lock, so concurrent CLI processes cannot interleave. */
const locked = <T>(dir: string, fn: () => T): T =>
	withLockSync(pool(dir), fn, {
		name: "ports.lock",
		timeoutMs: LOCK_WAIT_MS,
		problem: `port pool is locked (${lockFile(dir)})`,
	});

/** Whether nothing else listens on the port, on any address or on loopback. */
export async function bindable(port: number): Promise<boolean> {
	for (const host of [undefined, "127.0.0.1"]) {
		const ok = await new Promise<boolean>((resolve) => {
			const s = createServer();
			s.once("error", () => resolve(false));
			s.listen({ port, host, exclusive: true }, () =>
				s.close(() => resolve(true)),
			);
		});
		if (!ok) return false;
	}
	return true;
}

/**
 * A port from `range` for `child` of the run at `dir`, from the machine-wide pool.
 * A port another process already listens on is passed over, never handed out.
 */
export async function allocatePort(
	dir: string,
	range: [number, number],
	child: string,
	free: (port: number) => Promise<boolean> = bindable,
): Promise<number> {
	const busy: number[] = [];
	try {
		for (;;) {
			// Busy ports stay reserved meanwhile, so the next pick passes over them.
			const port = locked(dir, () => allocateUnlocked(dir, range, child));
			if (await free(port)) return port;
			busy.push(port);
		}
	} finally {
		for (const p of busy) releasePort(dir, p);
	}
}

export const releasePort = (dir: string, port: number): void =>
	locked(dir, () => keep(dir, (e) => e.port !== port));

/** Every port the run at `dir` handed to `child`, whether an env state file records it or not. */
export const releasePorts = (dir: string, child: string): void =>
	locked(dir, () =>
		keep(dir, (e) => !(e.run === basename(dir) && e.child === child)),
	);

function keep(dir: string, pred: (e: PortEntry) => boolean): void {
	write(dir, read(dir).filter(pred));
}

// Replaced whole, so a crash part way never leaves the machine's pool half written.
function write(dir: string, entries: PortEntry[]): void {
	writeFileAtomic(file(dir), JSON.stringify(entries));
}

function allocateUnlocked(
	dir: string,
	[lo, hi]: [number, number],
	child: string,
): number {
	// A crash between allocation and the env state file leaves an entry nobody holds: reclaim it.
	const live = read(dir).filter((e) => held(dir, e));
	const used = new Set([...live.map((e) => e.port), ...upPorts(dir)]);
	for (let p = lo; p <= hi; p++) {
		if (!used.has(p)) {
			const entry = { port: p, run: basename(dir), child, pid: process.pid };
			write(dir, [...live, entry]);
			return p;
		}
	}
	throw new PortiaProblem(`no free port in ${lo}-${hi}`);
}
