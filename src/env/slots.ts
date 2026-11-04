import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Profile } from "../core/config";
import { pidAlive } from "../core/process";
import { portiaHome } from "../core/rundir";
import { LOG, readRows } from "../core/runlog";
import { DECIDING } from "../core/state";
import type { RunRow } from "../core/types";
import { readRecord, type WorkerRecord } from "../worker/detached";
import { availableMb } from "./memory";

export interface Probes {
	freeMb(): number;
	/** When the process started, or undefined when it is not running; a reused pid starts later. */
	startedAt(pid: number): string | undefined;
	/** The long-lived process a dispatch belongs to: the session that starts the worker. */
	ownerPid(): number;
	now(): number;
}
export interface Slots {
	cap: number;
	/** Workers free memory above minFreeMb fits, at perWorkerMb each, less the ones still starting. */
	memory: number;
	/** Live workers in this run. */
	used: number;
	/** Live workers in other runs on this machine. */
	peers: number;
	/** Workers this run may start now. */
	available: number;
	/** This run's children counted in `used`. */
	running: string[];
}
interface Live {
	child: string;
	/** Dispatched within the warm-up, so its memory may not show in free memory yet. */
	starting: boolean;
}

/** A worker this young may not have taken its memory yet, so free memory is reserved for it. */
export const WARMUP_MS = 2 * 60_000;
/** A dispatch older than this is never live, whatever its owner pid now belongs to. */
export const MAX_AGE_MS = 24 * 60 * 60_000;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "env"]);

function psEntry(pid: number): { ppid: number; comm: string } | undefined {
	try {
		const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
		});
		const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(out);
		return m ? { ppid: Number(m[1]), comm: m[2] ?? "" } : undefined;
	} catch {
		return undefined;
	}
}

function startedAt(pid: number): string | undefined {
	if (!pidAlive(pid)) return undefined;
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
		}).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

// Each CLI call runs in a short-lived shell, so its parent dies at once; the session above it lives as long as its workers.
export function ownerPid(
	entry: (pid: number) => { ppid: number; comm: string } | undefined = psEntry,
	start = process.ppid,
	env: Record<string, string | undefined> = process.env,
): number {
	const set = Number(env.PORTIA_OWNER_PID);
	if (Number.isInteger(set) && set > 0) return set;
	let pid = start;
	for (let i = 0; i < 8; i++) {
		const e = entry(pid);
		if (!e || e.ppid <= 1 || !SHELLS.has(basename(e.comm).replace(/^-/, "")))
			return pid;
		pid = e.ppid;
	}
	return pid;
}

const real: Probes = {
	freeMb: () => availableMb(),
	startedAt,
	ownerPid: () => ownerPid(),
	now: () => Date.now(),
};
let override: Partial<Probes> | undefined;
/** Test seam: the memory and process probes every command uses. Returns a restore function. */
export function useProbes(p: Partial<Probes>): () => void {
	const prev = override;
	override = p;
	return () => {
		override = prev;
	};
}
export const probes = (): Probes => ({ ...real, ...override });

/** What a dispatch records so later calls can tell whether its owner still runs. */
export function owner(probe: Probes): { pid: number; started?: string } {
	const pid = probe.ownerPid();
	const started = probe.startedAt(pid);
	return started ? { pid, started } : { pid };
}

/** Whether a detached worker's process still runs: its pid, started when its record says. */
function recordLive(
	rec: WorkerRecord,
	probe: Pick<Probes, "startedAt">,
): boolean {
	const at = probe.startedAt(rec.pid);
	return at !== undefined && (!rec.proc || at === rec.proc);
}

/**
 * Children whose environment came up within the warm-up and that no dispatch has followed
 * yet: env up admitted their memory, so it stays reserved until the worker can take it.
 */
export function envReserved(
	rows: RunRow[],
	now: number,
	skip: ReadonlySet<string> = new Set(),
): Set<string> {
	const last = new Map<string, RunRow>();
	for (const r of rows)
		if (r.stage === "env" || r.stage === "dispatched") last.set(r.child, r);
	const out = new Set<string>();
	for (const [child, r] of last)
		if (
			r.stage === "env" &&
			r.status === "up" &&
			!skip.has(child) &&
			now - Date.parse(r.at) < WARMUP_MS
		)
			out.add(child);
	return out;
}

/**
 * Children whose last deciding row is a dispatch under a day old whose owner still runs:
 * the same pid, started at the same time. A dispatch with no recorded owner is never live.
 * With the run's `dir`, a detached worker started for that attempt is judged by its own
 * pid and start time instead, since it outlives the session that dispatched it.
 */
export function liveWorkers(
	rows: RunRow[],
	probe: Pick<Probes, "startedAt" | "now">,
	skip: ReadonlySet<string> = new Set(),
	dir?: string,
): Live[] {
	const last = new Map<string, RunRow>();
	for (const r of rows) if (DECIDING.has(r.stage)) last.set(r.child, r);
	const now = probe.now();
	const out: Live[] = [];
	for (const [child, r] of last) {
		if (r.stage !== "dispatched" || skip.has(child)) continue;
		const age = now - Date.parse(r.at);
		if (!(age < MAX_AGE_MS)) continue;
		let rec: ReturnType<typeof readRecord>;
		try {
			rec = dir ? readRecord(dir, child) : undefined;
		} catch {
			// An unreadable record may hide a live worker, so it holds its slot.
			out.push({ child, starting: false });
			continue;
		}
		if (rec && rec.attempt === r.attempt) {
			if (recordLive(rec, probe))
				out.push({ child, starting: age < WARMUP_MS });
			continue;
		}
		const pid = Number(r.data?.pid);
		const started = r.data?.started;
		if (!pid || typeof started !== "string") continue;
		if (probe.startedAt(pid) === started)
			out.push({ child, starting: age < WARMUP_MS });
	}
	return out;
}

/**
 * Every other run under the Portia home that could hold a live worker or a reservation.
 * A run log untouched for a day holds neither, so it is never read.
 */
function peerRuns(
	parent: string,
	now: number,
	env: Record<string, string | undefined>,
): { dir: string; rows: RunRow[] }[] {
	const runs = join(portiaHome(env), "runs");
	if (!existsSync(runs)) return [];
	return readdirSync(runs, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name !== parent.toUpperCase())
		.map((d) => join(runs, d.name))
		.filter((dir) => {
			try {
				return now - statSync(join(dir, LOG)).mtimeMs < MAX_AGE_MS;
			} catch {
				return false;
			}
		})
		.map((dir) => ({ dir, rows: readRows(dir).rows }));
}

/** Live workers in every other run under the Portia home. */
export function peerWorkers(
	parent: string,
	probe: Pick<Probes, "startedAt" | "now">,
	env: Record<string, string | undefined> = process.env,
): Live[] {
	return peerRuns(parent, probe.now(), env).flatMap(({ dir, rows }) =>
		liveWorkers(rows, probe, new Set(), dir),
	);
}

/** How many workers this run may start now; undefined when the profile sets no perWorkerMb. */
export function workerSlots(
	p: Profile,
	parent: string,
	rows: RunRow[],
	probe: Probes,
	opts: {
		/** Never counted: the child being dispatched and children closed outside the run. */
		skip?: Iterable<string>;
		/** The child's environment just came up, so its memory was admitted then: only the cap applies. */
		admitted?: boolean;
		/** This run's directory, so its detached workers are judged by their own pids. */
		dir?: string;
		env?: Record<string, string | undefined>;
	} = {},
): Slots | undefined {
	if (p.perWorkerMb === undefined) return undefined;
	const skip = new Set(opts.skip);
	const now = probe.now();
	const here = liveWorkers(rows, probe, skip, opts.dir);
	const peers = peerRuns(parent, now, opts.env ?? process.env);
	const there = peers.flatMap(({ dir, rows }) =>
		liveWorkers(rows, probe, new Set(), dir),
	);
	const starting = [...here, ...there].filter((w) => w.starting).length;
	// Environments up but not yet dispatched, here and in other runs, hold the memory env up admitted.
	const reserved =
		envReserved(rows, now, skip).size +
		peers.reduce((n, { rows }) => n + envReserved(rows, now).size, 0);
	// Free memory already nets out running workers; only the ones still starting are reserved.
	const memory = Math.max(
		0,
		Math.floor((probe.freeMb() - p.minFreeMb) / p.perWorkerMb) -
			starting -
			reserved,
	);
	const share = p.waveCap - here.length - there.length;
	// A run with nothing running gets one share of the cap, so it never waits on another run's landing.
	const cap = here.length === 0 ? Math.max(1, share) : Math.max(0, share);
	return {
		cap: p.waveCap,
		memory,
		used: here.length,
		peers: there.length,
		available: opts.admitted ? cap : Math.min(cap, memory),
		running: here.map((w) => w.child),
	};
}
