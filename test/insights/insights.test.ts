import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { insightsCommand } from "../../src/cli/commands/insights";
import { runMetrics } from "../../src/core/metrics";
import { writePlanSnapshot } from "../../src/core/plan-snapshot";
import { appendRow } from "../../src/core/runlog";
import type { Run } from "../../src/core/runs";
import type { RunRow, Stage } from "../../src/core/types";
import { wastedAttempts } from "../../src/insights/classify";
import { insights, renderInsights } from "../../src/insights/report";
import { child, parent } from "../helpers/plan";

const START = Date.parse("2026-10-01T09:00:00.000Z");

function run(key: string, children: string[]) {
	const rows: RunRow[] = [];
	const add = (
		minute: number,
		c: string,
		attempt: number,
		stage: Stage,
		rest: Partial<Pick<RunRow, "status" | "tokens" | "data">> = {},
	) => {
		rows.push({
			at: new Date(START + minute * 60_000).toISOString(),
			child: c,
			attempt,
			stage,
			...rest,
		});
	};
	const r: Run = {
		key,
		dir: "",
		rows,
		skipped: 0,
		plan: { ...parent(children.map((k) => child(k))), key },
		source: "plan",
		warnings: [],
	};
	return { r, add };
}

const landFailed = (reason: string, extra: Record<string, unknown> = {}) => ({
	status: "failed",
	data: { reason, ...extra },
});

it("puts a CI failure's own attempt and its retry under ci, caught once at CI", () => {
	const { r, add } = run("ACME-10", ["ACME-11"]);
	add(0, "ACME-11", 1, "dispatched");
	add(10, "ACME-11", 1, "result", { status: "done", tokens: 100 });
	add(11, "ACME-11", 1, "land", landFailed("CI failed on PR #9: build"));
	add(12, "ACME-11", 2, "dispatched");
	add(20, "ACME-11", 2, "result", { status: "done", tokens: 50 });
	add(21, "ACME-11", 2, "landed", { status: "landed" });
	const w = wastedAttempts(r);
	expect(w.map((a) => [a.attempt, a.cause, a.tokens])).toEqual([
		[1, { kind: "ci", outcome: "failed" }, 100],
		[2, { kind: "ci", outcome: "failed" }, 50],
	]);
	const report = insights([r]);
	expect(report.causes).toEqual([
		{ kind: "ci", count: 2, tokens: 150, minutes: 18, runs: 1 },
	]);
	expect(report.totals.caught.ci).toBe(1);
	expect(report.totals.rework.tokens).toBe(
		runMetrics(r.plan.children, r.rows).rework.tokens,
	);
});

it("reads each land reason into its own bucket, and an infra land as infra", () => {
	const reasons: [string, Record<string, unknown>, unknown][] = [
		[
			"ACME-1 changed after its gate passed at a (now b); nothing merged",
			{},
			{ kind: "changed-after-gate" },
		],
		[
			"CI on PR #3 still pending after 30 min",
			{ infra: true },
			{ kind: "infra" },
		],
		[
			"rebasing ACME-1 onto epic/ACME-0 conflicts",
			{},
			{ kind: "rebase-conflict" },
		],
		[
			"the child review found problems",
			{ review: "findings" },
			{ kind: "unknown", rows: [2] },
		],
	];
	for (const [reason, extra, cause] of reasons) {
		const { r, add } = run("ACME-0", ["ACME-1"]);
		add(0, "ACME-1", 1, "dispatched");
		add(5, "ACME-1", 1, "result", { status: "done", tokens: 10 });
		add(6, "ACME-1", 1, "land", landFailed(reason, extra));
		add(7, "ACME-1", 2, "dispatched");
		add(9, "ACME-1", 2, "result", { status: "done", tokens: 20 });
		add(10, "ACME-1", 2, "landed", { status: "landed" });
		expect(wastedAttempts(r).at(-1)?.cause).toEqual(cause);
	}
});

it("names a park on a failure, and a redispatch with no reason as unknown with its rows", () => {
	const { r, add } = run("ACME-0", ["ACME-1", "ACME-2"]);
	add(0, "ACME-1", 1, "dispatched");
	add(5, "ACME-1", 1, "result", { status: "failed", tokens: 10 });
	add(5, "ACME-1", 0, "decision", {
		status: "park",
		data: { kind: "failure", answer: "park" },
	});
	add(9, "ACME-1", 2, "dispatched");
	add(12, "ACME-1", 2, "result", { status: "done", tokens: 30 });
	add(0, "ACME-2", 1, "dispatched");
	add(5, "ACME-2", 1, "result", { status: "done", tokens: 40 });
	add(9, "ACME-2", 2, "dispatched");
	add(12, "ACME-2", 2, "result", { status: "done", tokens: 60 });
	expect(wastedAttempts(r).map((a) => a.cause)).toEqual([
		{ kind: "parked", on: "failure", resolution: "redispatched" },
		{ kind: "unknown", rows: [6] },
	]);
	expect(insights([r]).causes.map((c) => c.kind)).toEqual([
		"unknown",
		"parked",
	]);
});

it("counts the children landed before each epic-gate failure", () => {
	const { r, add } = run("ACME-0", ["ACME-1", "ACME-2"]);
	add(0, "ACME-1", 1, "landed", { status: "landed" });
	add(1, "ACME-0", 0, "epic", {
		status: "fail",
		data: {
			steps: [
				{ name: "lint", ok: true },
				{ name: "e2e", ok: false },
			],
		},
	});
	add(2, "ACME-2", 1, "landed", { status: "landed" });
	add(3, "ACME-0", 0, "epic", {
		status: "fail",
		data: { steps: [{ name: "unit", ok: false }] },
	});
	const t = insights([r]).totals;
	expect(t.epicGate).toEqual([
		{ step: "e2e", children: 1 },
		{ step: "unit", children: 2 },
	]);
	expect(t.epicGateFailures).toBe(2);
	expect(t.caught["epic-gate"]).toBe(2);
});

it("counts wave-gate failures apart from the epic gate's, and names each gate failure's run and time only when detailed", () => {
	const { r, add } = run("ACME-0", ["ACME-1", "ACME-2"]);
	add(0, "ACME-1", 1, "landed", { status: "landed" });
	add(1, "ACME-0", 0, "wave-gate", {
		status: "fail",
		data: { wave: 1, tip: "a", steps: [{ name: "integration", ok: false }] },
	});
	add(2, "ACME-0", 0, "wave-gate", {
		status: "pass",
		data: { wave: 1, tip: "b", steps: [{ name: "integration", ok: true }] },
	});
	add(3, "ACME-2", 1, "landed", { status: "landed" });
	add(4, "ACME-0", 0, "epic", {
		status: "fail",
		data: { steps: [{ name: "e2e", ok: false }] },
	});
	const plain = insights([r]);
	expect(plain.totals.waveGate).toEqual([
		{ wave: 1, step: "integration", children: 1 },
	]);
	expect(plain.totals.waveGateFailures).toBe(1);
	expect(plain.totals.caught["wave-gate"]).toBe(1);
	expect(plain.totals.caught["epic-gate"]).toBe(1);
	expect(JSON.stringify(plain)).not.toContain("ACME");
	expect(renderInsights(plain)).toContain(
		"wave 1 failed at integration, covering 1 child(ren)",
	);
	const detailed = insights([r], true);
	expect(detailed.detail?.waveGate).toEqual([
		{
			wave: 1,
			step: "integration",
			children: 1,
			run: "ACME-0",
			at: "2026-10-01T09:01:00.000Z",
		},
	]);
	const text = renderInsights(detailed);
	expect(text).toContain(
		"ACME-0 wave 1 gate failed at integration, 2026-10-01T09:01:00.000Z (1 child(ren))",
	);
	expect(text).toContain(
		"ACME-0 epic gate failed at e2e, 2026-10-01T09:04:00.000Z (2 child(ren))",
	);
});

it("gives a parked answer's text, keys and row ids only when detailed", () => {
	const { r, add } = run("ACME-0", ["ACME-1"]);
	add(0, "ACME-1", 1, "dispatched");
	add(5, "ACME-1", 1, "result", { status: "parked", tokens: 10 });
	add(6, "ACME-1", 0, "decision", {
		status: "answer",
		data: { kind: "parked", by: "eval", answer: "Use the euro" },
	});
	add(7, "ACME-1", 2, "dispatched");
	add(9, "ACME-1", 2, "result", { status: "done", tokens: 20 });
	const plain = JSON.stringify(insights([r]));
	expect(plain).not.toContain("euro");
	expect(plain).not.toContain("ACME");
	expect(Object.keys(insights([r]))).toEqual(["totals", "causes", "parks"]);
	const detailed = insights([r], true);
	expect(detailed.detail?.attempts[0]).toMatchObject({
		run: "ACME-0",
		child: "ACME-1",
		answer: "Use the euro",
		cause: { kind: "parked", on: "question", resolution: "answer" },
	});
	expect(renderInsights(detailed)).toContain("Use the euro");
	expect(renderInsights(insights([r]))).not.toContain("euro");
});

afterEach(() => vi.unstubAllEnvs());

it("keeps runs that started on or after --since, and warns on stderr only", async () => {
	const home = mkdtempSync(join(tmpdir(), "portia-insights-unit-"));
	vi.stubEnv("PORTIA_HOME", home);
	for (const [key, day] of [
		["ACME-0", "2026-09-01"],
		["ACME-5", "2026-10-02"],
	] as const) {
		const dir = join(home, "runs", key);
		mkdirSync(dir, { recursive: true });
		if (key === "ACME-0")
			writePlanSnapshot(dir, { ...parent([child("ACME-1")]), key });
		appendRow(dir, {
			at: `${day}T09:00:00.000Z`,
			child: key === "ACME-0" ? "ACME-1" : "ACME-6",
			attempt: 1,
			stage: "dispatched",
		});
	}
	const out: string[] = [];
	const err: string[] = [];
	const io = {
		out: (s: string) => out.push(s),
		err: (s: string) => err.push(s),
	};
	expect(await insightsCommand(["--json", "--since", "2026-10-01"], io)).toBe(
		0,
	);
	expect(JSON.parse(out.join("")).totals.runs).toBe(1);
	expect(err.join("\n")).toMatch(/no plan\.json/);
	await expect(insightsCommand(["--since", "soon"], io)).rejects.toThrow(
		/usage/,
	);
});
