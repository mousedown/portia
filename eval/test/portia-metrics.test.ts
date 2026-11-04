import { describe, expect, it } from "bun:test";
import { portiaMetrics } from "../src/metrics/portia";

// Two children, the shape of portia's fixture run log: 501 lands first time; 503 fails its
// exit gate, retries, changes a file outside its paths (approved), and lands on attempt 2.
const t = (hms: string) => `2026-10-20T${hms}.000Z`;
const row = (o: Record<string, unknown>) => JSON.stringify(o);
const LOG = [
	row({
		at: t("07:21:31"),
		child: "A-501",
		attempt: 0,
		stage: "env",
		status: "up",
	}),
	row({
		at: t("07:21:40"),
		child: "A-501",
		attempt: 1,
		stage: "dispatched",
		model: { requested: "opus" },
	}),
	row({
		at: t("07:39:22"),
		child: "A-501",
		attempt: 0,
		stage: "gate",
		status: "pass",
		data: { kind: "task" },
	}),
	row({
		at: t("07:47:11"),
		child: "A-501",
		attempt: 0,
		stage: "gate",
		status: "pass",
		data: { kind: "exit" },
	}),
	row({
		at: t("07:48:30"),
		child: "A-501",
		attempt: 1,
		stage: "result",
		status: "done",
		tokens: 100,
		model: { requested: "opus" },
		data: { outside: [] },
	}),
	row({
		at: t("08:02:40"),
		child: "A-501",
		attempt: 1,
		stage: "landed",
		status: "landed",
		data: { pr: 415 },
	}),
	row({
		at: t("08:05:10"),
		child: "A-503",
		attempt: 1,
		stage: "dispatched",
		model: { requested: "opus" },
	}),
	row({
		at: t("08:35:00"),
		child: "A-503",
		attempt: 0,
		stage: "gate",
		status: "fail",
		data: {
			kind: "exit",
			steps: [
				{ name: "typecheck", ok: true },
				{ name: "integration", ok: false },
			],
		},
	}),
	row({
		at: t("08:36:00"),
		child: "A-503",
		attempt: 1,
		stage: "result",
		status: "failed",
		tokens: 50,
		model: { requested: "opus" },
	}),
	row({
		at: t("08:36:20"),
		child: "A-503",
		attempt: 0,
		stage: "decision",
		status: "retry",
		data: { kind: "failure", by: "rule" },
	}),
	row({
		at: t("08:37:00"),
		child: "A-503",
		attempt: 2,
		stage: "dispatched",
		model: { requested: "sonnet" },
	}),
	row({
		at: t("08:59:03"),
		child: "A-503",
		attempt: 0,
		stage: "gate",
		status: "pass",
		data: { kind: "exit" },
	}),
	row({
		at: t("09:00:00"),
		child: "A-503",
		attempt: 2,
		stage: "result",
		status: "done",
		tokens: 150,
		model: { requested: "sonnet" },
		data: { outside: ["src/tax/rates.ts"] },
	}),
	row({
		at: t("09:12:30"),
		child: "A-503",
		attempt: 0,
		stage: "decision",
		status: "accept",
		data: { kind: "touches-mismatch", by: "person" },
	}),
	row({
		at: t("09:17:10"),
		child: "A-503",
		attempt: 2,
		stage: "landed",
		status: "landed",
		data: { pr: 421 },
	}),
	'{"at":"2026-10-20T09:18:00.000Z","child":"A-50', // a row mid-write
].join("\n");

const CHILDREN = [
	{ key: "A-501", touches: ["src/invoice/**"] },
	{ key: "A-503", touches: ["src/tax/rules/**"] },
];

describe("portiaMetrics", () => {
	const m = portiaMetrics(LOG, CHILDREN);
	it("counts tokens by model and in total", () => {
		expect(m.tokens).toBe(300);
		expect(m.tokensByModel).toEqual({ opus: 150, sonnet: 150 });
	});
	it("reads rework off attempts after the first", () => {
		expect(m.rework.retries).toBe(1);
		expect(m.rework.failedLands).toBe(0);
		expect(m.rework.tokenShare).toBeCloseTo(150 / 300);
		// 501: 26m50s; 503 a1: 30m50s, a2: 23m; rework share of minutes = 23 / 80.67
		expect(m.rework.minuteShare).toBeCloseTo(23 / (26.833 + 30.833 + 23), 2);
	});
	it("gives the first-pass land rate", () => {
		expect(m.firstPassLandRate).toBe(0.5);
	});
	it("counts a person's decisions", () => {
		expect(m.human.decisions).toBe(1);
	});
	it("counts files outside declared paths, from the result rows", () => {
		expect(m.safety.filesOutsideDeclaredPaths).toBe(1);
		expect(m.safety.mergesWithoutPassingGate).toBe(0);
	});
	it("names the gate step that failed", () => {
		expect(m.gateFailuresByStep).toEqual({ integration: 1 });
	});
	it("skips a row mid-write", () => {
		expect(() => portiaMetrics(LOG, CHILDREN)).not.toThrow();
	});
});

it("counts no decision for a park drive redispatched unasked, and one for a park put to someone", () => {
	const at = (hms: string) => `2026-10-20T${hms}.000Z`;
	const log = [
		{ at: at("08:00:00"), child: "A-1", attempt: 1, stage: "dispatched" },
		{
			at: at("08:01:00"),
			child: "A-1",
			attempt: 1,
			stage: "result",
			status: "parked",
			data: { message: "needs A-2" },
		},
		{
			at: at("08:02:00"),
			child: "A-2",
			attempt: 1,
			stage: "landed",
			status: "landed",
		},
		{ at: at("08:02:30"), child: "A-1", attempt: 2, stage: "dispatched" },
		{
			at: at("08:03:00"),
			child: "A-1",
			attempt: 2,
			stage: "result",
			status: "parked",
			data: { message: "?" },
		},
		{
			at: at("08:03:30"),
			child: "A-1",
			attempt: 0,
			stage: "decision",
			status: "answer",
			data: { kind: "parked", by: "eval", answer: "go" },
		},
		{ at: at("08:04:00"), child: "A-1", attempt: 3, stage: "dispatched" },
	]
		.map((o) => JSON.stringify(o))
		.join("\n");
	const m = portiaMetrics(log, [
		{ key: "A-1", touches: ["a/**"] },
		{ key: "A-2", touches: ["b/**"] },
	]);
	expect(m.human.decisions).toBe(1);
});
