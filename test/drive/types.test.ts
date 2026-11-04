import { expect, it } from "vitest";
import { EXIT } from "../../src/core/exit";
import {
	type DriveResult,
	renderDrive,
	STOP_KINDS,
	type Stop,
	stopExit,
	stopLine,
} from "../../src/drive/types";

const stops: Stop[] = [
	{ kind: "plan", reason: "no approved plan" },
	{
		kind: "questions",
		questions: [{ id: "q1", child: "GH-3", question: "Which port?" }],
	},
	{
		kind: "spec-signoff",
		spine: "GH-2",
		attempt: 1,
		head: "0123456789abcdef",
		specs: { F1: "test/spine.test.ts" },
	},
	{ kind: "parked", child: "GH-3", attempt: 1, question: "Which greeting?" },
	{ kind: "failed", child: "GH-1", step: "epic-gate", reason: "lint failed" },
	{ kind: "epic-ready", landed: ["GH-2", "GH-3"], pr: 7 },
	{ kind: "error", message: "gh is not logged in" },
	{
		kind: "spec-amendment",
		child: "GH-3",
		attempt: 2,
		spine: "GH-2",
		path: "test/spine.test.ts",
		scenario: "F1",
		assertion: 'expect(spine()).toBe("spine")',
		evidence: "fails whatever spine() returns",
		amendment: { status: "started" },
	},
];

it("names every stop kind once, and each example covers one", () => {
	expect(new Set(STOP_KINDS).size).toBe(STOP_KINDS.length);
	expect(stops.map((s) => s.kind).sort()).toEqual([...STOP_KINDS].sort());
});

it("exits 0 only at epic-ready, 11 when drive failed or broke, else 10", () => {
	const exits = Object.fromEntries(stops.map((s) => [s.kind, stopExit(s)]));
	expect(exits).toEqual({
		plan: EXIT.NOTHING,
		questions: EXIT.NOTHING,
		"spec-signoff": EXIT.NOTHING,
		parked: EXIT.NOTHING,
		failed: EXIT.PROBLEM,
		"epic-ready": EXIT.OK,
		error: EXIT.PROBLEM,
		"spec-amendment": EXIT.NOTHING,
	});
});

it("puts what the orchestrator acts on into each stop's line", () => {
	const lines = stops.map(stopLine);
	for (const [i, s] of stops.entries())
		expect(lines[i]?.startsWith(`${s.kind}: `)).toBe(true);
	expect(lines[2]).toContain("GH-2 attempt 1 at 0123456");
	expect(lines[3]).toContain("GH-3 attempt 1 asks: Which greeting?");
	expect(lines[4]).toContain("GH-1 at epic-gate: lint failed");
	expect(lines[5]).toBe("epic-ready: 2 landed, PR #7");
	expect(lines[7]).toBe(
		'spec-amendment: GH-3 attempt 2 says test/spine.test.ts (F1) cannot pass as written (amendment started): expect(spine()).toBe("spine")',
	);
});

it("names the couplings to settle and a park that keeps repeating", () => {
	expect(
		stopLine({
			kind: "spec-signoff",
			spine: "GH-2",
			attempt: 1,
			head: "0123456789abcdef",
			specs: { F1: "test/spine.test.ts" },
			coupling: [
				{
					scenario: "F1",
					spec: "test/spine.test.ts",
					owner: "GH-3",
					other: "GH-4",
					via: "route",
					target: "/b/price",
				},
			],
		}),
	).toContain(
		"settle 1 coupling(s) first: F1 (GH-3) reaches GH-4 via /b/price",
	);
	expect(
		stopLine({
			kind: "parked",
			child: "GH-3",
			attempt: 3,
			question: "Which greeting?",
			repeats: [1, 2, 3].map((attempt) => ({ attempt, question: "Which?" })),
		}),
	).toContain("parked 3 times running on one head");
});

it("renders each step on its own line, then the stop", () => {
	const r: DriveResult = {
		parent: "GH-1",
		steps: [
			{
				step: "dispatch",
				child: "GH-2",
				attempt: 1,
				ok: true,
				detail: "model opus",
				at: "2026-10-30T09:00:00.000Z",
			},
			{
				step: "land",
				child: "GH-2",
				ok: false,
				detail: "exit gate failed",
				at: "2026-10-30T09:05:00.000Z",
			},
		],
		stop: { kind: "error", message: "boom" },
	};
	expect(renderDrive(r).split("\n")).toEqual([
		"ok   dispatch GH-2 #1: model opus",
		"FAIL land GH-2: exit gate failed",
		"stop error: boom",
	]);
});
