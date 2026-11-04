import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { CAUSES, type CauseTotal } from "../../src/core/causes";
import { type RunMetrics, runMetrics } from "../../src/core/metrics";
import { writePlanSnapshot } from "../../src/core/plan-snapshot";
import { listRuns } from "../../src/core/runs";
import type { RunRow } from "../../src/core/types";
import { child, parent, spine } from "../helpers/plan";
import { portia, runLog } from "./support";

const PERSON = "Grace Hopper";
const WORKTREES = "/home/grace/worktrees/acme-web";
const SUMMARIES = [
	"Shared invoice reader",
	"Rename the invoice total",
	"Export the ledger as CSV",
	"Invoices you can trust",
];
const PATHS = [
	"packages/acme-web/src/invoices/total.ts",
	"src/ledger/csv.ts",
	WORKTREES,
];

/**
 * Two runs. ACME-100 has a plan snapshot; ACME-200 has none, so its children come from its
 * run log. Each wasted attempt has one plain reason: a child gate failing `test`, an exit gate
 * failing `typecheck` on the rebased head, a rebase conflict, and a park on a question.
 */
function twoRuns(home: string) {
	const a = runLog(home, "ACME-100");
	writePlanSnapshot(a.dir, {
		...parent([
			spine({
				key: "ACME-101",
				summary: SUMMARIES[0],
				touches: ["packages/acme-web/src/invoices/**"],
			}),
			child("ACME-102", { summary: SUMMARIES[1] }),
			child("ACME-103", { summary: SUMMARIES[2] }),
		]),
		key: "ACME-100",
		summary: SUMMARIES[3] as string,
	});
	const env = (key: string) => ({
		status: "up",
		data: { worktree: `${WORKTREES}/${key}`, branch: `epic/${key}` },
	});
	const steps = (failing?: string) => ({
		steps: [
			{ name: "lint", ok: true },
			{ name: failing ?? "test", ok: failing === undefined },
		],
	});
	a.add(0, "ACME-101", 0, "env", env("ACME-101"));
	a.add(0, "ACME-101", 1, "dispatched");
	a.add(9, "ACME-101", 0, "gate", {
		status: "pass",
		data: { kind: "exit", ...steps() },
	});
	a.add(10, "ACME-101", 1, "result", {
		status: "done",
		tokens: 1_000,
		data: { head: "a1" },
	});
	a.add(11, "ACME-101", 0, "signoff", {
		status: "approved",
		data: { by: "person", commit: "a1", note: `Looks right to ${PERSON}` },
	});
	a.add(12, "ACME-101", 1, "landed", {
		status: "landed",
		data: { pr: 1, sha: "a1", onto: "b0" },
	});

	a.add(13, "ACME-102", 0, "env", env("ACME-102"));
	a.add(13, "ACME-102", 1, "dispatched");
	a.add(30, "ACME-102", 0, "gate", {
		status: "fail",
		data: { kind: "task", ...steps("test") },
	});
	a.add(31, "ACME-102", 1, "result", {
		status: "failed",
		tokens: 2_000,
		data: { message: `gate failed: test in ${PATHS[0]}` },
	});
	a.add(31, "ACME-102", 0, "decision", {
		status: "retry",
		data: {
			kind: "failure",
			by: "rule",
			answer: "retry",
			why: "attempt 1 of 2",
		},
	});
	a.add(32, "ACME-102", 2, "dispatched");
	a.add(50, "ACME-102", 0, "gate", {
		status: "pass",
		data: { kind: "exit", ...steps() },
	});
	a.add(51, "ACME-102", 2, "result", {
		status: "done",
		tokens: 1_500,
		data: { head: "c2" },
	});
	a.add(53, "ACME-102", 2, "landed", {
		status: "landed",
		data: { pr: 2, sha: "c2", onto: "b1" },
	});

	a.add(13, "ACME-103", 0, "env", env("ACME-103"));
	a.add(13, "ACME-103", 1, "dispatched");
	a.add(40, "ACME-103", 1, "result", {
		status: "done",
		tokens: 3_000,
		data: { head: "d1" },
	});
	a.add(41, "ACME-103", 0, "gate", {
		status: "fail",
		data: { kind: "exit", ...steps("typecheck") },
	});
	a.add(42, "ACME-103", 1, "land", {
		status: "failed",
		data: {
			reason: `exit gate failed on the rebased head (R6): typecheck\n${PATHS[1]}(3,1): error TS2339`,
		},
	});
	a.add(43, "ACME-103", 2, "dispatched");
	a.add(60, "ACME-103", 2, "result", {
		status: "done",
		tokens: 2_500,
		data: { head: "d2" },
	});
	a.add(61, "ACME-103", 0, "gate", {
		status: "pass",
		data: { kind: "exit", ...steps() },
	});
	a.add(62, "ACME-103", 2, "landed", {
		status: "landed",
		data: { pr: 3, sha: "d2", onto: "b2" },
	});
	a.add(70, "ACME-100", 0, "epic", {
		status: "fail",
		data: { steps: [{ name: "test", ok: false }] },
	});

	const b = runLog(home, "ACME-200");
	b.add(0, "ACME-201", 0, "env", env("ACME-201"));
	b.add(0, "ACME-201", 1, "dispatched");
	b.add(40, "ACME-201", 1, "result", {
		status: "done",
		tokens: 4_000,
		data: { head: "e1" },
	});
	b.add(41, "ACME-201", 1, "land", {
		status: "parked",
		data: { reason: "rebasing ACME-201 onto epic/ACME-200 conflicts" },
	});
	b.add(45, "ACME-201", 2, "dispatched");
	b.add(70, "ACME-201", 2, "result", {
		status: "done",
		tokens: 3_500,
		data: { head: "e2" },
	});
	b.add(71, "ACME-201", 0, "gate", {
		status: "pass",
		data: { kind: "exit", ...steps() },
	});
	b.add(72, "ACME-201", 2, "landed", {
		status: "landed",
		data: { pr: 4, sha: "e2", onto: "f1" },
	});

	b.add(0, "ACME-202", 0, "env", env("ACME-202"));
	b.add(0, "ACME-202", 1, "dispatched");
	b.add(10, "ACME-202", 1, "result", {
		status: "parked",
		tokens: 800,
		data: { message: `Should the CSV include VAT? Asking ${PERSON}` },
	});
	b.add(20, "ACME-202", 0, "decision", {
		status: "answer",
		data: {
			kind: "parked",
			by: "eval",
			answer: "Include VAT",
			why: "Should the CSV include VAT?",
		},
	});
	b.add(21, "ACME-202", 2, "dispatched");
	b.add(35, "ACME-202", 2, "result", {
		status: "done",
		tokens: 900,
		data: { head: "g2" },
	});
	b.add(36, "ACME-202", 0, "gate", {
		status: "pass",
		data: { kind: "exit", ...steps() },
	});
	b.add(37, "ACME-202", 2, "landed", {
		status: "landed",
		data: { pr: 5, sha: "g2", onto: "f2" },
	});
	writeFileSync(join(home, "runs", "ports.json"), "[]");
}

/** The attempts runMetrics counts as rework: every retry, and an attempt whose land failed and never landed. */
function wastedAttempts(children: { key: string }[], rows: RunRow[]): number {
	let n = 0;
	for (const c of children) {
		const mine = rows.filter((r) => r.child === c.key);
		for (const d of mine.filter((r) => r.stage === "dispatched")) {
			const landed = mine.some(
				(r) => r.stage === "landed" && r.attempt === d.attempt,
			);
			const failedLand = mine.some(
				(r) =>
					r.stage === "land" &&
					r.status === "failed" &&
					r.data?.infra !== true &&
					r.attempt === d.attempt,
			);
			if (d.attempt > 1 || (failedLand && !landed)) n++;
		}
	}
	return n;
}

let home: string;
type Totals = Pick<
	RunMetrics,
	"landed" | "firstPass" | "tokens" | "workMinutes" | "rework"
>;
let expected: { metrics: Totals; wasted: number };

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "portia-insights-"));
	twoRuns(home);
	const runs = listRuns([], { PORTIA_HOME: home });
	expect(runs.map((r) => r.key)).toEqual(["ACME-100", "ACME-200"]);
	const each = runs.map((r) => runMetrics(r.plan.children, r.rows));
	const sum = (f: (m: RunMetrics) => number) =>
		each.reduce((s, m) => s + f(m), 0);
	expected = {
		metrics: {
			landed: sum((m) => m.landed),
			firstPass: sum((m) => m.firstPass),
			tokens: sum((m) => m.tokens),
			workMinutes: sum((m) => m.workMinutes),
			rework: {
				tokens: sum((m) => m.rework.tokens),
				minutes: sum((m) => m.rework.minutes),
				retries: sum((m) => m.rework.retries),
				failedLands: sum((m) => m.rework.failedLands),
			},
		},
		wasted: runs.reduce(
			(s, r) => s + wastedAttempts(r.plan.children, r.rows),
			0,
		),
	};
	expect(expected.metrics.landed).toBe(5);
	expect(expected.wasted).toBe(5);
	expect(expected.metrics.rework.tokens).toBe(11_400);
});

function insightsJson(...args: string[]) {
	const r = portia(["insights", "--json", ...args], { home });
	expect(r.err).not.toMatch(/not built yet/);
	expect(r.code).toBe(0);
	return { text: r.out, report: JSON.parse(r.out) };
}

it("I1: Given the run logs of two runs, Then the insights command reports totals equal to runMetrics summed over both", () => {
	const { report } = insightsJson();
	const m = expected.metrics;
	expect(report.totals).toMatchObject(m);
});

it("I2: Given the run logs of two runs, Then every wasted attempt falls into exactly one cause, and causes are ranked by tokens lost", () => {
	const { report } = insightsJson();
	const causes = report.causes as CauseTotal[];
	expect(causes.length).toBeGreaterThan(0);
	for (const c of causes) expect(CAUSES).toContain(c.kind);
	const ids = causes.map((c) => `${c.kind}:${c.step ?? ""}`);
	expect(new Set(ids).size).toBe(ids.length);
	expect(causes.reduce((s, c) => s + c.count, 0)).toBe(expected.wasted);
	expect(causes.reduce((s, c) => s + c.tokens, 0)).toBe(
		expected.metrics.rework.tokens,
	);
	expect([...ids].sort()).toEqual(
		[
			"child-gate:test",
			"exit-gate-rebased:typecheck",
			"parked:",
			"rebase-conflict:",
		].sort(),
	);
	const tokens = causes.map((c) => c.tokens);
	expect(tokens).toEqual([...tokens].sort((x, y) => y - x));
});

it("I3: Given the insights command with --json and without --detailed, Then the output contains no ticket key, file path, title or person", () => {
	const { text, report } = insightsJson();
	expect(report.causes.length).toBeGreaterThan(0);
	expect(text).not.toMatch(/\b[A-Z][A-Z0-9]+-\d+\b/);
	for (const s of [
		PERSON,
		"Grace",
		"Hopper",
		...SUMMARIES,
		...PATHS,
		"packages/",
		"src/",
		"VAT",
	])
		expect(text).not.toContain(s);
});
