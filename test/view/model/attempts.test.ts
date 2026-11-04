import { describe, expect, it } from "vitest";
import type { RunRow } from "../../../src/core/types";
import { groupAttempts } from "../../../src/view/model/attempts";
import {
	gateField,
	gateRun,
	gateSummary,
	stepCatalog,
	strip,
} from "../../../src/view/model/gates";
import { phaseOf, QUIET_MS } from "../../../src/view/model/phase";
import { phrase } from "../../../src/view/model/phrase";
import type { Event } from "../../../src/view/model/types";

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const r = (min: number, o: Partial<RunRow>): RunRow => ({
	at: at(min),
	child: "ACME-505",
	attempt: 0,
	stage: "env",
	...o,
});
const gate = (
	min: number,
	kind: "task" | "exit",
	names: string[],
	failAt?: string,
): RunRow =>
	r(min, {
		stage: "gate",
		status: failAt ? "fail" : "pass",
		data: {
			kind,
			steps: names
				.slice(0, failAt ? names.indexOf(failAt) + 1 : names.length)
				.map((name) => ({ name, ok: name !== failAt })),
		},
	});
const events = (rows: RunRow[]): Event[] =>
	rows.map((row, i) => ({
		id: `ACME-500:${i}`,
		at: row.at,
		run: "ACME-500",
		child: row.child,
		attempt: row.attempt,
		row,
		phrase: phrase(row),
	}));
const CAT = {
	task: ["typecheck", "lint"],
	exit: ["typecheck", "lint", "unit", "e2e"],
};

const ROWS: RunRow[] = [
	r(0, { stage: "env", status: "up", data: { port: 3101 } }),
	r(1, { stage: "dispatched", attempt: 1, model: { requested: "sonnet" } }),
	gate(10, "task", CAT.task),
	gate(20, "exit", CAT.exit),
	r(21, { stage: "result", attempt: 1, status: "done", tokens: 1000 }),
	r(22, {
		stage: "decision",
		status: "accept",
		data: { kind: "touches-mismatch", by: "rule" },
	}),
	gate(40, "exit", CAT.exit, "unit"),
	r(41, {
		stage: "land",
		attempt: 1,
		status: "failed",
		data: { reason: "exit gate failed: unit\n\nmore" },
	}),
	r(42, {
		stage: "decision",
		status: "retry",
		data: { kind: "failure", by: "rule", why: "attempt 1 of 2" },
	}),
	r(43, { stage: "dispatched", attempt: 2, model: { requested: "sonnet" } }),
	gate(50, "task", CAT.task),
];

describe("groupAttempts", () => {
	const list = groupAttempts(events(ROWS), true, CAT);
	it("puts attempt-0 rows in the current attempt, and an early env up in the attempt it set up", () => {
		expect(list.map((a) => a.n)).toEqual([1, 2]);
		expect(list[0]?.events.map((e) => e.row.stage)).toEqual([
			"env",
			"dispatched",
			"gate",
			"gate",
			"result",
			"decision",
			"gate",
			"land",
			"decision",
		]);
		expect(list[1]?.events.map((e) => e.row.stage)).toEqual([
			"dispatched",
			"gate",
		]);
		// It is timed from its dispatch, not from the env up it carries.
		expect(list[0]?.startedAt).toBe(at(1));
	});
	it("sets outcomes, tokens, the last gate of each kind and gate durations", () => {
		expect(list[0]).toMatchObject({
			outcome: "land failed",
			tokens: 1000,
			// It ends at the land failure, not at the retry decision after it.
			endedAt: at(41),
		});
		expect(list[0]?.exit?.pass).toBe(false);
		expect(list[1]?.outcome).toBe("running");
		expect(list[1]?.events[1]?.durationMs).toBe(7 * 60_000);
	});
	it("shows a synthetic attempt 0 only when it is the only one", () => {
		const lone = groupAttempts(
			events([r(0, { stage: "decision", status: "park", data: {} })]),
			false,
			CAT,
		);
		expect(lone.map((a) => a.n)).toEqual([0]);
	});
});

describe("gates", () => {
	it("builds the catalogue in first-seen order, inserting later steps after their predecessor", () => {
		const rows = [
			gate(0, "exit", ["typecheck", "unit"]),
			gate(1, "exit", ["typecheck", "lint", "unit", "e2e"]),
		];
		expect(stepCatalog(rows, "exit")).toEqual([
			"typecheck",
			"lint",
			"unit",
			"e2e",
		]);
	});
	it("draws the steps after a failure as never run", () => {
		const g = gateRun(gate(0, "exit", CAT.exit, "unit"), CAT.exit);
		expect(g.steps.map((s) => s.ok)).toEqual([true, true, false, null]);
		const cells = strip(
			"failed",
			undefined,
			[{ n: 1, startedAt: at(0), events: [], exit: g }],
			CAT,
		);
		expect(cells.map((c) => c.kind)).toEqual([
			"unrun",
			"unrun",
			"gap",
			"pass",
			"pass",
			"fail",
			"unrun",
		]);
		expect(gateField(cells, CAT)).toBe("task:- exit:fail@unit");
	});
	it("shows the running gate as active", () => {
		const list = groupAttempts(events(ROWS), true, CAT);
		const cells = strip("running", "exit gate", list, CAT);
		expect(gateSummary(cells)).toBe("task:pass exit:running");
		expect(
			gateSummary(
				strip(
					"running",
					"working",
					[{ n: 1, startedAt: at(0), events: [] }],
					CAT,
				),
			),
		).toBe("task:running exit:-");
	});
});

describe("phaseOf", () => {
	const now = Date.parse(at(5));
	const ph = (rows: RunRow[], n = now) => phaseOf(rows, "running", n)?.phase;
	it("infers the phase from the newest row after the dispatch", () => {
		const d = r(0, { stage: "dispatched", attempt: 1 });
		expect(ph([d, r(1, { stage: "env", status: "up" })])).toBe("working");
		expect(ph([d, gate(1, "task", CAT.task)])).toBe("exit gate");
		expect(ph([d, gate(1, "task", CAT.task, "lint")])).toBe("fixing");
		expect(ph([d, gate(1, "exit", CAT.exit, "unit")])).toBe("fixing");
		expect(ph([d, gate(1, "exit", CAT.exit)])).toBe("reporting");
		expect(ph([d, r(1, { stage: "decision", status: "retry" })])).toBe(
			"working",
		);
		expect(
			phaseOf([d, r(1, { stage: "result", status: "done" })], "done", now)
				?.phase,
		).toBe("landing");
	});
	it("goes quiet at exactly 45 minutes without a row, and not a second before", () => {
		const d = r(0, { stage: "dispatched", attempt: 1 });
		expect(ph([d], T0 + QUIET_MS)).toBe("quiet");
		expect(ph([d], T0 + QUIET_MS - 1000)).toBe("working");
	});
});

describe("phrase", () => {
	it("names every row kind", () => {
		expect(phrase(ROWS[1] as RunRow)).toMatchObject({
			glyph: "dispatched",
			detail: "attempt 1 · sonnet",
		});
		expect(phrase(gate(0, "task", ["a", "b"]))).toMatchObject({
			label: "task gate",
			detail: "a ✓  b ✓",
		});
		expect(phrase(gate(0, "exit", ["a", "b", "c", "d", "e"])).detail).toBe(
			"5 of 5 steps passed",
		);
		expect(phrase(ROWS[7] as RunRow)).toMatchObject({
			label: "land failed",
			detail: "exit gate failed: unit",
			fold: "more",
		});
		expect(
			phrase(r(0, { stage: "landed", data: { pr: 427, sha: "3f9e2c1aa" } }))
				.detail,
		).toBe("#427 · 3f9e2c1");
		expect(
			phrase(
				r(0, {
					stage: "dispatched",
					attempt: 1,
					model: { requested: "opus", actual: "sonnet" },
				}),
			).detail,
		).toBe("attempt 1 · opus→sonnet");
	});
});
