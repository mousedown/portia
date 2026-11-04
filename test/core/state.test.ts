import { describe, expect, it } from "vitest";
import {
	closedOutsideRun,
	closedWarning,
	deriveStates,
	gatedWaves,
	readySet,
	scheduleOf,
	waveGateDue,
	waveOpen,
} from "../../src/core/state";
import type { RunRow } from "../../src/core/types";
import { child, parent, spine } from "../helpers/plan";

const needOn1 = {
	needs: [{ key: "ACME-1", reason: "r" }],
	blockedBy: ["ACME-1"],
};
const plan = parent([
	spine(),
	child("ACME-2", needOn1),
	child("ACME-3", needOn1),
]);
const row = (
	child: string,
	stage: RunRow["stage"],
	status?: string,
): RunRow => ({ at: "t", child, attempt: 1, stage, status });

it("only the spine is ready on a fresh run", () => {
	const s = deriveStates(plan, []);
	expect(Object.fromEntries(s)).toEqual({
		"ACME-1": "ready",
		"ACME-2": "pending",
		"ACME-3": "pending",
	});
});

it("children become ready when the spine lands, and follow their latest row", () => {
	const s = deriveStates(plan, [
		row("ACME-1", "dispatched"),
		row("ACME-1", "result", "done"),
		row("ACME-1", "landed"),
		row("ACME-2", "dispatched"),
		row("ACME-2", "result", "parked"),
	]);
	expect(Object.fromEntries(s)).toEqual({
		"ACME-1": "landed",
		"ACME-2": "parked",
		"ACME-3": "ready",
	});
	expect(readySet(s)).toEqual(["ACME-3"]);
});

it("a re-dispatch after a park reads as running", () => {
	const s = deriveStates(plan, [
		row("ACME-1", "landed"),
		row("ACME-2", "result", "parked"),
		row("ACME-2", "dispatched"),
	]);
	expect(s.get("ACME-2")).toBe("running");
});

it("a wave-1 child with no needs stays pending until the spine lands", () => {
	const free = parent([spine(), child("ACME-2"), child("ACME-3", { wave: 2 })]);
	expect(Object.fromEntries(deriveStates(free, []))).toEqual({
		"ACME-1": "ready",
		"ACME-2": "pending",
		"ACME-3": "pending",
	});
	const afterSpine = deriveStates(free, [row("ACME-1", "landed")]);
	expect(afterSpine.get("ACME-2")).toBe("ready");
	expect(afterSpine.get("ACME-3")).toBe("pending");
	const afterWave1 = deriveStates(free, [
		row("ACME-1", "landed"),
		row("ACME-2", "landed"),
	]);
	expect(afterWave1.get("ACME-3")).toBe("ready");
});

it("a need on a done issue outside the run counts as met", () => {
	const p = {
		...parent([
			spine(),
			child("ACME-2", {
				needs: [{ key: "ACME-90", reason: "r" }],
				blockedBy: ["ACME-90"],
			}),
		]),
		satisfied: ["ACME-90"],
	};
	expect(deriveStates(p, [row("ACME-1", "landed")]).get("ACME-2")).toBe(
		"ready",
	);
	const unmet = { ...p, satisfied: [] };
	expect(deriveStates(unmet, [row("ACME-1", "landed")]).get("ACME-2")).toBe(
		"pending",
	);
});

describe("a planned child closed outside the run", () => {
	const p = { ...plan, closed: ["ACME-1"] };
	it("is closed, never ready, and counts as met for its needs and the wave barrier", () => {
		const s = deriveStates(p, []);
		expect(Object.fromEntries(s)).toEqual({
			"ACME-1": "closed",
			"ACME-2": "ready",
			"ACME-3": "ready",
		});
		expect(readySet(s)).toEqual(["ACME-2", "ACME-3"]);
		expect(closedOutsideRun(p, [])).toEqual(["ACME-1"]);
	});
	it("stays closed whatever rows it has, so it is never re-dispatched", () => {
		for (const rows of [
			[row("ACME-1", "dispatched")],
			[row("ACME-1", "dispatched"), row("ACME-1", "result", "failed")],
		])
			expect(deriveStates(p, rows).get("ACME-1")).toBe("closed");
	});
	it("is landed, with no warning, once it has a landed row", () => {
		const rows = [row("ACME-1", "landed")];
		expect(deriveStates(p, rows).get("ACME-1")).toBe("landed");
		expect(closedOutsideRun(p, rows)).toEqual([]);
	});
	it("warns in the words status and check use", () => {
		expect(closedWarning("ACME-1")).toBe(
			"ACME-1: closed outside the run, not landed",
		);
	});
});

describe("the wave gate barrier", () => {
	const waves = parent([
		spine(),
		child("ACME-2"),
		child("ACME-3", { wave: 2 }),
	]);
	const passed = (wave: number, tip = "t1"): RunRow => ({
		...row("ACME-0", "wave-gate", "pass"),
		data: { wave, tip, steps: [] },
	});

	it("with waveGate, wave 1 waits for a passing wave-gate row for wave 0", () => {
		const landed = [row("ACME-1", "landed")];
		const opts = { waveGate: true };
		expect(deriveStates(waves, landed, opts).get("ACME-2")).toBe("pending");
		expect(waveGateDue(waves, landed)).toBe(0);
		const failed = {
			...row("ACME-0", "wave-gate", "fail"),
			data: { wave: 0, tip: "t1", steps: [] },
		};
		expect(deriveStates(waves, [...landed, failed], opts).get("ACME-2")).toBe(
			"pending",
		);
		const s = deriveStates(waves, [...landed, failed, passed(0)], opts);
		expect(s.get("ACME-2")).toBe("ready");
		expect(s.get("ACME-3")).toBe("pending");
		expect(waveGateDue(waves, [...landed, passed(0)])).toBeUndefined();
	});

	it("without waveGate, the barrier is unchanged", () => {
		expect(deriveStates(waves, [row("ACME-1", "landed")]).get("ACME-2")).toBe(
			"ready",
		);
	});

	it("is due only once every child of the wave is landed or closed, and never after the last wave", () => {
		const two = parent([
			spine(),
			child("ACME-2"),
			child("ACME-4"),
			child("ACME-3", { wave: 2 }),
		]);
		const early = [row("ACME-1", "landed"), passed(0), row("ACME-2", "landed")];
		expect(waveGateDue(two, early)).toBeUndefined();
		expect(waveOpen(two, early, 1)).toEqual(["ACME-4"]);
		const closed = { ...two, closed: ["ACME-4"] };
		expect(waveGateDue(closed, early)).toBe(1);
		const all = [...early, passed(1), row("ACME-3", "landed")];
		expect(deriveStates(closed, early, { waveGate: true }).get("ACME-3")).toBe(
			"pending",
		);
		expect(waveGateDue(closed, all)).toBeUndefined();
		expect(gatedWaves(two)).toEqual([0, 1]);
	});
});

describe("scheduling by needs", () => {
	const p = parent([
		spine(),
		child("ACME-2"),
		child("ACME-3", { wave: 2 }),
		child("ACME-4", {
			wave: 2,
			touches: ["packages/acme-web/src/ACME-2/extra.ts"],
		}),
		child("ACME-5", {
			wave: 2,
			needs: [{ key: "ACME-2", reason: "r" }],
			blockedBy: ["ACME-2"],
		}),
	]);
	const afterSpine = [row("ACME-1", "landed")];

	it("starts a later wave as soon as the spine is in, unless it shares files or needs an earlier child", () => {
		const s = deriveStates(p, afterSpine, scheduleOf({ schedule: "needs" }));
		expect(Object.fromEntries(s)).toEqual({
			"ACME-1": "landed",
			"ACME-2": "ready",
			"ACME-3": "ready",
			"ACME-4": "pending",
			"ACME-5": "pending",
		});
		const after2 = deriveStates(
			p,
			[...afterSpine, row("ACME-2", "landed")],
			scheduleOf({ schedule: "needs" }),
		);
		expect(after2.get("ACME-4")).toBe("ready");
		expect(after2.get("ACME-5")).toBe("ready");
	});

	it("never starts anything before the spine lands", () => {
		const s = deriveStates(p, [], scheduleOf({ schedule: "needs" }));
		expect(readySet(s)).toEqual(["ACME-1"]);
	});

	it("keeps whole waves by default, and whenever a wave gate runs between them", () => {
		expect(deriveStates(p, afterSpine).get("ACME-3")).toBe("pending");
		const gated = scheduleOf({
			schedule: "needs",
			waveGate: { steps: ["test"] },
		});
		expect(gated.byNeeds).toBeUndefined();
		expect(deriveStates(p, afterSpine, gated).get("ACME-3")).toBe("pending");
	});
});
