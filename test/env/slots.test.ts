import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Profile, testProfile } from "../../src/core/config";
import { appendRow } from "../../src/core/runlog";
import type { RunRow } from "../../src/core/types";
import {
	envReserved,
	liveWorkers,
	MAX_AGE_MS,
	ownerPid,
	type Probes,
	peerWorkers,
	WARMUP_MS,
	workerSlots,
} from "../../src/env/slots";
import { type WorkerRecord, workerPaths } from "../../src/worker/detached";

const NOW = Date.parse("2026-01-01T12:00:00Z");
/** Live pids and when each started; any other pid is not running. */
const STARTED: Record<number, string> = {
	100: "s100",
	200: "s200",
	300: "s300",
};
const probes = (freeMb: number, now = NOW): Probes => ({
	freeMb: () => freeMb,
	startedAt: (pid) => STARTED[pid],
	ownerPid: () => 100,
	now: () => now,
});
const OLD = new Date(NOW - WARMUP_MS - 1000).toISOString();
const row = (
	child: string,
	stage: RunRow["stage"],
	pid?: number,
	at = OLD,
	started = pid ? `s${pid}` : undefined,
): RunRow => ({
	at,
	child,
	attempt: 1,
	stage,
	...(pid ? { data: { pid, started } } : {}),
});
const profile = (over: Partial<Profile> = {}): Profile => ({
	...testProfile(),
	waveCap: 3,
	minFreeMb: 4096,
	perWorkerMb: 2048,
	...over,
});
const home = () => mkdtempSync(join(tmpdir(), "portia-home-"));
const run = (h: string, parent: string, rows: RunRow[]) => {
	const dir = join(h, "runs", parent);
	mkdirSync(dir, { recursive: true });
	for (const r of rows) appendRow(dir, r);
};
const kids = (rows: RunRow[], p = probes(0), skip?: Set<string>) =>
	liveWorkers(rows, p, skip).map((w) => w.child);

describe("liveWorkers", () => {
	it("counts children whose last deciding row is a dispatch by a live owner", () => {
		const rows = [
			row("A-1", "dispatched", 100),
			row("A-2", "dispatched", 100),
			row("A-2", "result"),
			row("A-3", "dispatched", 999),
			row("A-4", "dispatched", 200),
			row("A-4", "env"),
		];
		expect(kids(rows)).toEqual(["A-1", "A-4"]);
	});

	it("never counts a dispatch with no recorded owner", () => {
		expect(kids([row("A-1", "dispatched")])).toEqual([]);
	});

	it("does not count a reused pid: the owner must have started when it was recorded", () => {
		expect(kids([row("A-1", "dispatched", 100, OLD, "earlier")])).toEqual([]);
	});

	it("ages out a dispatch older than a day", () => {
		const stale = new Date(NOW - MAX_AGE_MS - 1).toISOString();
		expect(kids([row("A-1", "dispatched", 100, stale)])).toEqual([]);
	});

	it("leaves out the children it is told to skip", () => {
		const rows = [row("A-1", "dispatched", 100), row("A-2", "dispatched", 100)];
		expect(kids(rows, probes(0), new Set(["A-1"]))).toEqual(["A-2"]);
	});

	it("marks a dispatch within the warm-up as still starting", () => {
		const rows = [
			row("A-1", "dispatched", 100, new Date(NOW - 1000).toISOString()),
			row("A-2", "dispatched", 100),
		];
		expect(liveWorkers(rows, probes(0))).toEqual([
			{ child: "A-1", starting: true },
			{ child: "A-2", starting: false },
		]);
	});
});

describe("envReserved", () => {
	const just = new Date(NOW - 1000).toISOString();
	const up = (child: string, at = just): RunRow => ({
		at,
		child,
		attempt: 0,
		stage: "env",
		status: "up",
	});
	it("holds an environment just up until its dispatch", () => {
		const rows = [
			up("A-1"),
			up("A-2"),
			row("A-2", "dispatched", 100, just),
			up("A-3", OLD),
			up("A-4"),
			{ ...up("A-4"), status: "down" },
			up("A-5"),
		];
		expect([...envReserved(rows, NOW, new Set(["A-5"]))]).toEqual(["A-1"]);
	});
	it("takes memory from the slots, here and in other runs", () => {
		const h = home();
		run(h, "B-1", [up("B-2")]);
		// (12288 - 4096) / 2048 = 4, less one held here and one in B-1.
		const s = workerSlots(profile(), "A-1", [up("A-2")], probes(12_288), {
			env: { PORTIA_HOME: h },
		});
		expect(s).toMatchObject({ memory: 2, used: 0, peers: 0 });
	});
});

describe("peerWorkers", () => {
	it("counts live workers in other runs only", () => {
		const h = home();
		run(h, "A-1", [row("A-2", "dispatched", 100)]);
		run(h, "B-1", [row("B-2", "dispatched", 200), row("B-3", "dispatched")]);
		run(h, "C-1", [row("C-2", "dispatched", 999)]);
		expect(peerWorkers("A-1", probes(0), { PORTIA_HOME: h })).toHaveLength(1);
		expect(peerWorkers("Z-1", probes(0), { PORTIA_HOME: h })).toHaveLength(2);
	});

	it("never reads a run log untouched for a day", () => {
		const h = home();
		run(h, "B-1", [row("B-2", "dispatched", 200)]);
		const old = (NOW - MAX_AGE_MS - 1000) / 1000;
		utimesSync(join(h, "runs", "B-1", "runlog.jsonl"), old, old);
		expect(peerWorkers("A-1", probes(0), { PORTIA_HOME: h })).toEqual([]);
	});

	it("is empty when no run has started", () => {
		expect(peerWorkers("A-1", probes(0), { PORTIA_HOME: home() })).toEqual([]);
	});
});

describe("workerSlots", () => {
	const env = (h = home()) => ({ env: { PORTIA_HOME: h } });

	it("is undefined without perWorkerMb, so dispatch behaves as before", () => {
		const p = profile({ perWorkerMb: undefined });
		expect(workerSlots(p, "A-1", [], probes(0), env())).toBeUndefined();
	});

	it("is the wave cap when memory allows more", () => {
		expect(workerSlots(profile(), "A-1", [], probes(64_000), env())).toEqual({
			cap: 3,
			memory: 29,
			used: 0,
			peers: 0,
			available: 3,
			running: [],
		});
	});

	it("does not count running workers twice: free memory already nets them out", () => {
		// (6144 - 4096) / 2048 = 1 more fits beside the one running.
		const rows = [row("A-2", "dispatched", 100)];
		const s = workerSlots(profile(), "A-1", rows, probes(6144), env());
		expect(s).toMatchObject({ memory: 1, used: 1, available: 1 });
	});

	it("reserves memory for workers dispatched within the warm-up", () => {
		const just = new Date(NOW - 1000).toISOString();
		const rows = [row("A-2", "dispatched", 100, just)];
		const s = workerSlots(profile(), "A-1", rows, probes(8192), env());
		expect(s).toMatchObject({ memory: 1, used: 1, available: 1 });
	});

	it("shares the cap with other live runs on the machine", () => {
		const h = home();
		run(h, "B-1", [
			row("B-2", "dispatched", 200),
			row("B-3", "dispatched", 300),
		]);
		const rows = [row("A-2", "dispatched", 100)];
		const s = workerSlots(profile(), "A-1", rows, probes(64_000), env(h));
		expect(s).toMatchObject({ used: 1, peers: 2, available: 0 });
	});

	it("ignores runs whose owner has exited", () => {
		const h = home();
		run(h, "B-1", [row("B-2", "dispatched", 999)]);
		const s = workerSlots(profile(), "A-1", [], probes(64_000), env(h));
		expect(s).toMatchObject({ peers: 0, available: 3 });
	});

	it("gives a run with nothing running one share of the cap, so it never waits on another run", () => {
		const h = home();
		run(h, "B-1", [
			row("B-2", "dispatched", 200),
			row("B-3", "dispatched", 300),
		]);
		const s = workerSlots(
			profile({ waveCap: 2 }),
			"A-1",
			[],
			probes(64_000),
			env(h),
		);
		expect(s).toMatchObject({ used: 0, peers: 2, available: 1 });
	});

	it("never goes over the memory budget, even with nothing running", () => {
		const s = workerSlots(profile(), "A-1", [], probes(5000), env());
		expect(s).toMatchObject({ memory: 0, used: 0, available: 0 });
	});

	it("applies only the cap once the child's environment has admitted it", () => {
		const s = workerSlots(profile(), "A-1", [], probes(0), {
			...env(),
			admitted: true,
		});
		expect(s).toMatchObject({ memory: 0, available: 3 });
	});

	it("does not count skipped children: the one being dispatched, or one closed outside the run", () => {
		const rows = [row("A-2", "dispatched", 100), row("A-3", "dispatched", 100)];
		const s = workerSlots(
			profile({ waveCap: 2 }),
			"A-1",
			rows,
			probes(64_000),
			{
				...env(),
				skip: ["A-2", "A-3"],
			},
		);
		expect(s).toMatchObject({ used: 0, available: 2, running: [] });
	});
});

describe("slots with detached workers", () => {
	/** A detached worker record for `child`'s attempt 1, as portia worker start writes it. */
	const started = (dir: string, child: string, pid: number, proc?: string) => {
		const rec: WorkerRecord = {
			child,
			attempt: 1,
			pid,
			...(proc ? { proc } : {}),
			worktree: dir,
			log: join(dir, "w.log"),
			result: join(dir, "r.json"),
			startedAt: OLD,
		};
		writeFileSync(workerPaths(dir, child, 1).record, JSON.stringify(rec));
	};
	const dirWith = (rows: RunRow[]) => {
		const h = home();
		run(h, "A-1", rows);
		return { h, dir: join(h, "runs", "A-1") };
	};
	const live = (rows: RunRow[], dir: string) =>
		liveWorkers(rows, probes(0), new Set(), dir).map((w) => w.child);

	it("counts a detached worker whose own process runs after the dispatching session ended", () => {
		// Owner 999 is gone; the worker, pid 200, still runs as the process it was started as.
		const rows = [row("A-2", "dispatched", 999, OLD, "s999")];
		const { dir } = dirWith(rows);
		started(dir, "A-2", 200, "s200");
		expect(live(rows, dir)).toEqual(["A-2"]);
		expect(kids(rows)).toEqual([]);
	});
	it("frees the slot of a dead detached worker while the dispatching session still runs", () => {
		const rows = [row("A-2", "dispatched", 100)];
		const { dir } = dirWith(rows);
		started(dir, "A-2", 400, "s400");
		expect(live(rows, dir)).toEqual([]);
	});
	it("frees the slot when the worker's pid now belongs to another process", () => {
		const rows = [row("A-2", "dispatched", 100)];
		const { dir } = dirWith(rows);
		started(dir, "A-2", 200, "s-earlier");
		expect(live(rows, dir)).toEqual([]);
	});
	it("frees the slot once a stalled worker is recorded as failed", () => {
		const rows = [
			row("A-2", "dispatched", 100),
			{ ...row("A-2", "result"), data: { status: "failed" } },
		];
		const { dir } = dirWith(rows);
		started(dir, "A-2", 200, "s200");
		expect(live(rows, dir)).toEqual([]);
	});
	it("judges a dispatch by its owner until its detached worker starts", () => {
		const rows = [
			row("A-2", "dispatched", 100),
			{ ...row("A-3", "dispatched", 100), attempt: 2 },
		];
		const { dir } = dirWith(rows);
		// A-3's record is for attempt 1, an older worker: its owner decides.
		started(dir, "A-3", 400, "s400");
		expect(live(rows, dir)).toEqual(["A-2", "A-3"]);
	});
	it("counts another run's detached workers by their own pids", () => {
		const { h, dir } = dirWith([row("A-2", "dispatched", 999, OLD, "s999")]);
		started(dir, "A-2", 300, "s300");
		expect(peerWorkers("Z-1", probes(0), { PORTIA_HOME: h })).toHaveLength(1);
	});
	it("takes a slot in workerSlots for this run's detached worker", () => {
		const rows = [row("A-2", "dispatched", 999, OLD, "s999")];
		const { h, dir } = dirWith(rows);
		started(dir, "A-2", 200, "s200");
		const s = workerSlots(profile(), "A-1", rows, probes(64_000), {
			dir,
			env: { PORTIA_HOME: h },
		});
		expect(s).toMatchObject({ used: 1, running: ["A-2"], available: 2 });
		const without = workerSlots(profile(), "A-1", rows, probes(64_000), {
			env: { PORTIA_HOME: h },
		});
		expect(without).toMatchObject({ used: 0 });
	});
	it("an unreadable worker record holds its slot, and does not break other runs", () => {
		const { h, dir } = dirWith([row("A-2", "dispatched", 999, OLD, "s999")]);
		writeFileSync(workerPaths(dir, "A-2", 1).record, '{"child":"A-2","pi');
		expect(peerWorkers("Z-1", probes(0), { PORTIA_HOME: h })).toEqual([
			{ child: "A-2", starting: false },
		]);
	});
});

describe("ownerPid", () => {
	const tree: Record<number, { ppid: number; comm: string }> = {
		40: { ppid: 30, comm: "/bin/zsh" },
		30: { ppid: 20, comm: "-zsh" },
		20: { ppid: 1, comm: "claude" },
	};
	it("skips the shells between the CLI and the session that runs it", () => {
		expect(ownerPid((pid) => tree[pid], 40, {})).toBe(20);
	});
	it("is the direct parent when it is not a shell", () => {
		expect(ownerPid((pid) => tree[pid], 20, {})).toBe(20);
	});
	it("is the parent when the process table cannot be read", () => {
		expect(ownerPid(() => undefined, 40, {})).toBe(40);
	});
	it("is PORTIA_OWNER_PID when it is set", () => {
		expect(ownerPid((pid) => tree[pid], 40, { PORTIA_OWNER_PID: "7" })).toBe(7);
	});
});
