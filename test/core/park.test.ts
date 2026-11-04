import { describe, expect, it } from "vitest";
import { answerable, waitOf } from "../../src/core/park";
import type { RunRow } from "../../src/core/types";

const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 12, m)).toISOString();
const rows = (...r: Omit<RunRow, "child">[]): RunRow[] =>
	r.map((x) => ({ child: "ACME-2", ...x }));
const dispatched = (m: number, attempt = 1): Omit<RunRow, "child"> => ({
	at: at(m),
	attempt,
	stage: "dispatched",
});
const LIMITED =
	"every account is at its usage limit or not logged in (a until 2026-10-20T15:30:00.000Z); the soonest frees at 2026-10-20T15:30:00.000Z. Run portia accounts clear <name> if one has reset sooner or been logged in";

describe("what a parked child waits on", () => {
	it("a worker's question waits on the person, from when it was recorded", () => {
		expect(
			waitOf(
				rows(dispatched(0), {
					at: at(10),
					attempt: 1,
					stage: "result",
					status: "parked",
					data: { message: "Which colour?" },
				}),
			),
		).toEqual({
			kind: "question",
			text: "Which colour?",
			at: at(10),
			attempt: 1,
		});
	});

	it("a parked land waits on the person, with its reason", () => {
		expect(
			waitOf(
				rows(dispatched(0), {
					at: at(10),
					attempt: 1,
					stage: "land",
					status: "parked",
					data: { reason: "rebasing ACME-2 onto epic/ACME-1 conflicts" },
				}),
			),
		).toMatchObject({
			kind: "question",
			text: "rebasing ACME-2 onto epic/ACME-1 conflicts",
		});
	});

	it("a failure decided as park waits on the person, unless every account is at its usage limit", () => {
		const failed: Omit<RunRow, "child"> = {
			at: at(10),
			attempt: 2,
			stage: "result",
			status: "failed",
			data: { message: "exit gate failed" },
		};
		const decided = (why: string): Omit<RunRow, "child"> => ({
			at: at(11),
			attempt: 0,
			stage: "decision",
			status: "park",
			data: { kind: "failure", answer: "park", why },
		});
		expect(waitOf(rows(dispatched(0, 2), failed))).toBeUndefined();
		expect(
			waitOf(rows(dispatched(0, 2), failed, decided("all 2 attempts used"))),
		).toEqual({
			kind: "question",
			text: "exit gate failed\n\nall 2 attempts used",
			at: at(11),
			attempt: 2,
		});
		expect(waitOf(rows(dispatched(0, 2), failed, decided(LIMITED)))).toEqual({
			kind: "limit",
			text: LIMITED,
			at: at(11),
			attempt: 2,
			frees: "2026-10-20T15:30:00.000Z",
		});
	});

	it("ends with an answer, a redispatch or a landing", () => {
		const parked: Omit<RunRow, "child"> = {
			at: at(10),
			attempt: 1,
			stage: "result",
			status: "parked",
			data: { message: "?" },
		};
		expect(
			waitOf(
				rows(dispatched(0), parked, {
					at: at(12),
					attempt: 0,
					stage: "decision",
					status: "answer",
					data: { kind: "parked", by: "eval", answer: "yes" },
				}),
			),
		).toBeUndefined();
		expect(
			waitOf(
				rows(dispatched(0), parked, {
					at: at(12),
					attempt: 0,
					stage: "decision",
					status: "answered",
					data: { kind: "park-answerable", answer: "answered" },
				}),
			),
		).toBeUndefined();
		expect(
			waitOf(
				rows(dispatched(0), parked, {
					at: at(12),
					attempt: 0,
					stage: "decision",
					status: "ask-human",
					data: { kind: "park-answerable", answer: "ask-human" },
				}),
			),
		).toMatchObject({ kind: "question" });
		expect(
			waitOf(rows(dispatched(0), parked, dispatched(20, 2))),
		).toBeUndefined();
		expect(
			waitOf(
				rows(dispatched(0), parked, {
					at: at(30),
					attempt: 1,
					stage: "landed",
				}),
			),
		).toBeUndefined();
	});
});

describe("what a person's answer answers", () => {
	const decision = (
		m: number,
		status: string,
		data: Record<string, unknown>,
	): Omit<RunRow, "child"> => ({
		at: at(m),
		attempt: 0,
		stage: "decision",
		status,
		data,
	});
	const result = (
		m: number,
		attempt: number,
		status: string,
		message: string,
	): Omit<RunRow, "child"> => ({
		at: at(m),
		attempt,
		stage: "result",
		status,
		data: { message },
	});

	it("takes an answer after a park already answered and then put to the person, as a spine that parked and hit its cap was", () => {
		// The run-9 sequence: parked, answered by the script, put to the person.
		const r = rows(
			dispatched(0, 4),
			result(10, 4, "parked", "Which values does the contract use?"),
			decision(11, "answer", {
				kind: "parked",
				by: "eval",
				answer: "Carry on.",
			}),
			decision(12, "ask-human", {
				kind: "park-answerable",
				by: "rule",
				answer: "ask-human",
			}),
		);
		expect(waitOf(r)).toBeUndefined();
		expect(answerable(r)).toEqual({
			text: "Which values does the contract use?",
			attempt: 4,
		});
	});

	it("takes an answer for a failure decided as park, answered or not, but not one waiting on a usage limit", () => {
		const failed = result(10, 2, "failed", "the gate failed");
		const park = decision(11, "park", {
			kind: "failure",
			why: "all 2 attempts used",
		});
		expect(answerable(rows(dispatched(0, 2), failed, park))).toMatchObject({
			attempt: 2,
		});
		expect(
			answerable(
				rows(
					dispatched(0, 2),
					failed,
					park,
					decision(12, "answer", { kind: "parked", answer: "Try X." }),
				),
			),
		).toEqual({ text: "the gate failed", attempt: 2 });
		expect(
			answerable(
				rows(
					dispatched(0, 2),
					failed,
					decision(11, "park", { kind: "failure", why: LIMITED }),
				),
			),
		).toBeUndefined();
	});

	it("takes none for a child running, retrying or with nothing asked", () => {
		expect(answerable(rows(dispatched(0)))).toBeUndefined();
		expect(
			answerable(
				rows(
					dispatched(0),
					result(10, 1, "failed", "boom"),
					decision(11, "retry", { kind: "failure" }),
				),
			),
		).toBeUndefined();
		expect(
			answerable(
				rows(dispatched(0), result(10, 1, "parked", "Q?"), dispatched(20, 2)),
			),
		).toBeUndefined();
	});
});
