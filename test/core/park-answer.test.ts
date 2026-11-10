import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { waitOf } from "../../src/core/park";
import { answeredSince, recordParkAnswer } from "../../src/core/park-answer";
import { appendRow, readRows } from "../../src/core/runlog";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "portia-"));
});

const parked = (at: string) =>
	appendRow(dir, {
		at,
		child: "A-2",
		attempt: 1,
		stage: "result",
		status: "parked",
		data: { message: "Which one?" },
	});

describe("recording a person's answer to a parked child", () => {
	it("records an answer as the row drive reads", () => {
		parked("2026-11-03T10:00:00.000Z");
		recordParkAnswer(dir, "A-2", "  the first  ");
		const row = readRows(dir).rows.at(-1);
		expect(row?.status).toBe("answer");
		expect(row?.data).toMatchObject({
			kind: "parked",
			by: "person",
			answer: "the first",
			why: "Which one?",
		});
		expect(waitOf(readRows(dir).rows)).toBeUndefined();
	});

	it("refuses an empty answer, and a child that asks nothing", () => {
		parked("2026-11-03T10:00:00.000Z");
		expect(() => recordParkAnswer(dir, "A-2", "  ")).toThrow(/empty/);
		expect(() => recordParkAnswer(dir, "A-9", "x")).toThrow(/not parked/);
	});

	it("with onlyWaitingSince, refuses a question already answered or replaced", () => {
		parked("2026-11-03T10:00:00.000Z");
		recordParkAnswer(dir, "A-2", "first");
		expect(() =>
			recordParkAnswer(dir, "A-2", "second", {
				onlyWaitingSince: "2026-11-03T10:00:00.000Z",
			}),
		).toThrow(/no longer waiting/);
	});

	it("with onlyWaitingSince, refuses a spec claim; without it, still records", () => {
		appendRow(dir, {
			at: "2026-11-03T10:00:00.000Z",
			child: "A-2",
			attempt: 1,
			stage: "result",
			status: "parked",
			data: { message: "cannot pass", spec: { path: "a.feature" } },
		});
		expect(() =>
			recordParkAnswer(dir, "A-2", "x", {
				onlyWaitingSince: "2026-11-03T10:00:00.000Z",
			}),
		).toThrow(/spec claim, settled by amendment from the session/);
		recordParkAnswer(dir, "A-2", "x");
		expect(readRows(dir).rows.at(-1)?.status).toBe("answer");
	});

	it("answeredSince names answers not yet acted on, newer than since", () => {
		parked("2026-11-03T10:00:00.000Z");
		expect(answeredSince(readRows(dir).rows)).toEqual([]);
		appendRow(dir, {
			at: "2026-11-03T10:05:00.000Z",
			child: "A-2",
			attempt: 1,
			stage: "decision",
			status: "answer",
			data: { kind: "parked", by: "person", answer: "x" },
		});
		const rows = readRows(dir).rows;
		expect(answeredSince(rows)).toEqual(["A-2"]);
		expect(answeredSince(rows, "2026-11-03T10:06:00.000Z")).toEqual([]);
		appendRow(dir, {
			at: "2026-11-03T10:07:00.000Z",
			child: "A-2",
			attempt: 2,
			stage: "dispatched",
			status: "ok",
		});
		expect(answeredSince(readRows(dir).rows)).toEqual([]);
	});
});

describe("a question's suggested answers", () => {
	const row = (data: Record<string, unknown>) => ({
		at: "2026-11-03T10:00:00.000Z",
		child: "A-2",
		attempt: 1,
		stage: "result" as const,
		status: "parked" as const,
		data: { message: "Which?", ...data },
	});
	it("waitOf exposes them from the result row", () => {
		expect(
			waitOf([row({ options: ["a", "b"], recommended: 1 })]),
		).toMatchObject({
			kind: "question",
			options: ["a", "b"],
			recommended: 1,
		});
	});
	it("has none without them, and never parses them out of the prose", () => {
		const w = waitOf([row({ message: "Which?\n1. a\n2. b\n(recommended)" })]);
		expect(w).toMatchObject({ kind: "question" });
		expect(w).not.toHaveProperty("options");
		expect(w).not.toHaveProperty("recommended");
	});
	it("a bad value in the log is dropped when read", () => {
		const w = waitOf([row({ options: "a,b", recommended: 9 })]);
		expect(w).toMatchObject({ kind: "question", text: "Which?" });
		expect(w).not.toHaveProperty("options");
		expect(waitOf([row({ options: ["a", "b"], recommended: 9 })])).toEqual(
			expect.not.objectContaining({ recommended: 9 }),
		);
	});
	it("a land's park and a failure decided as park offer none", () => {
		const land = {
			...row({}),
			stage: "land" as const,
			data: { reason: "conflict", options: ["a", "b"] },
		};
		expect(waitOf([land])).not.toHaveProperty("options");
		const failed = waitOf([
			{ ...row({ options: ["a", "b"] }), status: "failed" as const },
			{
				at: "2026-11-03T10:00:01.000Z",
				child: "A-2",
				attempt: 1,
				stage: "decision" as const,
				status: "park",
				data: { kind: "failure", why: "stuck" },
			},
		]);
		expect(failed).toMatchObject({ kind: "question" });
		expect(failed).not.toHaveProperty("options");
	});
});
