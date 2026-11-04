import { expect, it } from "vitest";
import { percent, runMetrics } from "../../src/core/metrics";
import type { RunRow } from "../../src/core/types";
import { metricsCells, renderLedger } from "../../src/ledger/render";
import { parseLedger } from "../../src/view/model/ledger";
import { child, parent, spine } from "../helpers/plan";

const at = (min: number) =>
	new Date(Date.UTC(2026, 9, 21, 9, 0) + min * 60_000).toISOString();
const row = (
	min: number,
	c: string,
	attempt: number,
	stage: RunRow["stage"],
	extra: Partial<RunRow> = {},
): RunRow => ({ at: at(min), child: c, attempt, stage, ...extra });
const gateFail = (min: number, c: string, step: string): RunRow =>
	row(min, c, 0, "gate", {
		status: "fail",
		data: {
			kind: "exit",
			steps: [
				{ name: "typecheck", ok: true },
				{ name: step, ok: false },
			],
		},
	});

const plan = parent([spine(), child("ACME-2"), child("ACME-3")]);
const rows: RunRow[] = [
	row(0, "ACME-187", 0, "approval", {
		status: "approved",
		data: { by: "person" },
	}),
	// The spine: one attempt, landed first time.
	row(0, "ACME-1", 1, "dispatched"),
	row(40, "ACME-1", 1, "result", { status: "done", tokens: 100 }),
	row(45, "ACME-1", 1, "signoff", {
		status: "approved",
		data: { by: "eval" },
	}),
	row(50, "ACME-1", 1, "landed"),
	// ACME-2: its first land failed, its second attempt landed.
	row(60, "ACME-2", 1, "dispatched"),
	row(80, "ACME-2", 1, "result", { status: "done", tokens: 200 }),
	gateFail(85, "ACME-2", "unit"),
	row(86, "ACME-2", 1, "land", { status: "failed", data: { reason: "x" } }),
	row(90, "ACME-2", 2, "dispatched"),
	row(120, "ACME-2", 2, "result", { status: "done", tokens: 300 }),
	row(130, "ACME-2", 2, "landed"),
	// ACME-3: parked, answered by the script, landed on attempt 1 after an infra failure.
	row(60, "ACME-3", 1, "dispatched"),
	row(70, "ACME-3", 1, "result", { status: "parked", tokens: 50 }),
	row(71, "ACME-3", 0, "decision", {
		status: "answer",
		data: { kind: "parked", by: "eval" },
	}),
	gateFail(72, "ACME-3", "unit"),
	gateFail(73, "ACME-3", "lint"),
	row(74, "ACME-3", 1, "land", {
		status: "failed",
		data: { reason: "ci", infra: true },
	}),
	row(75, "ACME-3", 1, "landed"),
];

it("rework, critical path, decisions and gate failures from the run log", () => {
	const m = runMetrics(plan.children, rows);
	expect(m).toMatchObject({
		landed: 3,
		// ACME-2 failed a land of its own; ACME-3's land failed on CI, which is not its.
		firstPass: 2,
		tokens: 650,
		workMinutes: 40 + 20 + 30 + 10,
		// ACME-2's first attempt never landed and its second is a retry.
		rework: { tokens: 500, minutes: 50, retries: 1, failedLands: 1 },
		// Wave 0's slowest is 40m; wave 1's is ACME-2 at 50m.
		criticalPathMinutes: 90,
		decisions: { signoffs: 2, parks: 1, scripted: 2 },
	});
	expect(m.gateFailures).toEqual([
		{ step: "unit", wave: 1, count: 2 },
		{ step: "lint", wave: 1, count: 1 },
	]);
});

it("a run with nothing finished has no figures to divide by", () => {
	const m = runMetrics(plan.children, [row(0, "ACME-1", 1, "dispatched")]);
	expect(m).toMatchObject({ landed: 0, tokens: 0, workMinutes: 0 });
	expect(percent(m.rework.tokens, m.tokens)).toBe(0);
	expect(metricsCells(m)[0]).toEqual([
		"First-pass land rate",
		"nothing landed yet",
	]);
});

it("the ledger prints the figures in a table the view's ledger reader skips", () => {
	const md = renderLedger(plan, [], runMetrics(plan.children, rows));
	expect(md).toContain("### Metrics");
	for (const line of [
		"| First-pass land rate | 67% (2 of 3 landed) |",
		"| Rework | 77% of tokens, 50% of minutes (1 retry, 1 failed land) |",
		"| Critical path vs work | 1h30m of 1h40m worker time |",
		"| Human decisions | 3 (2 sign-offs, 1 park), 2 scripted |",
		"| Gate failures | unit ×2 (wave 1 ×2), lint ×1 (wave 1) |",
	])
		expect(md).toContain(line);
	expect(md.indexOf("### Metrics")).toBeLessThan(md.indexOf("### Evidence"));
	expect(
		parseLedger(`<!-- epic-ledger:start -->\n${md}\n<!-- epic-ledger:end -->`)
			?.rows,
	).toEqual([]);
	expect(renderLedger(plan, [])).not.toContain("### Metrics");
});

it("a sign-off drive made by rule is nobody's decision", () => {
	const ruled = rows.map((r) =>
		r.stage === "signoff" ? { ...r, data: { by: "rule" } } : r,
	);
	expect(runMetrics(plan.children, ruled).decisions).toEqual({
		signoffs: 1,
		parks: 1,
		scripted: 1,
	});
});
