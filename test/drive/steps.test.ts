import { describe, expect, it } from "vitest";
import { PortiaProblem } from "../../src/core/exit";
import type { RunRow } from "../../src/core/types";
import {
	call,
	childNext,
	PARK_REPEATS,
	parkRepeats,
	planApproved,
	specsSignoff,
} from "../../src/drive/steps";

let tick = 0;
const row = (o: Partial<RunRow> & Pick<RunRow, "stage">): RunRow => ({
	at: new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
	child: "A",
	attempt: 1,
	...o,
});

describe("call", () => {
	it("runs a command in process and reads its first JSON line", async () => {
		const c = await call(
			async (args, io) => {
				io.out("not json");
				io.out(JSON.stringify({ args }));
				return 0;
			},
			["x"],
		);
		expect(c).toMatchObject({ code: 0, json: { args: ["x"] } });
	});

	it("maps a PortiaProblem to exit 11 with its message", async () => {
		const c = await call(async () => {
			throw new PortiaProblem("no slot");
		}, []);
		expect(c).toMatchObject({ code: 11, err: "no slot" });
	});

	it("lets any other error through, so drive stops instead of retrying", async () => {
		await expect(
			call(async () => {
				throw new Error("simulated kill");
			}, []),
		).rejects.toThrow("simulated kill");
	});
});

describe("childNext", () => {
	const dispatched = row({ stage: "dispatched" });

	it("lands a done child", () => {
		expect(childNext([], "A", "done")).toEqual({ next: "land" });
	});

	it("lands again after CI or GitHub failed the land", () => {
		const rows = [
			dispatched,
			row({ stage: "result", status: "done" }),
			row({ stage: "land", status: "failed", data: { infra: true } }),
		];
		expect(childNext(rows, "A", "failed")).toEqual({ next: "reland" });
	});

	it("stops on a broken child review instead of redispatching", () => {
		const rows = [
			dispatched,
			row({
				stage: "land",
				status: "failed",
				data: { review: "error", reason: "review crashed" },
			}),
		];
		expect(childNext(rows, "A", "failed")).toEqual({
			next: "broken",
			reason: "review crashed",
		});
	});

	it("decides a failure once, then follows the decision", () => {
		const failedRows = [
			dispatched,
			row({ stage: "result", status: "failed", data: { message: "red" } }),
		];
		expect(childNext(failedRows, "A", "failed")).toEqual({
			next: "decide",
			reason: "red",
		});
		const retry = row({
			stage: "decision",
			attempt: 0,
			status: "retry",
			data: { kind: "failure", answer: "retry" },
		});
		expect(childNext([...failedRows, retry], "A", "failed")).toEqual({
			next: "restart",
		});
		const park = row({
			stage: "decision",
			attempt: 0,
			status: "park",
			data: { kind: "failure", answer: "park", why: "out of retries" },
		});
		expect(childNext([...failedRows, park], "A", "failed")).toEqual({
			next: "ask",
			attempt: 1,
			question: "red\n\nout of retries",
		});
	});

	it("waits on a park until it is answered, then restarts with the answer", () => {
		const parked = [
			dispatched,
			row({ stage: "result", status: "parked", data: { message: "Which?" } }),
		];
		expect(childNext(parked, "A", "parked")).toEqual({
			next: "ask",
			attempt: 1,
			question: "Which?",
		});
		const answered = row({
			stage: "decision",
			attempt: 1,
			status: "answer",
			data: { kind: "parked", by: "person", answer: "This one." },
		});
		expect(childNext([...parked, answered], "A", "parked")).toEqual({
			next: "restart",
			note: "This one.",
		});
	});

	it("has nothing to do for a child still running or pending", () => {
		expect(childNext([dispatched], "A", "running")).toEqual({ next: "none" });
		expect(childNext([], "A", "pending")).toEqual({ next: "none" });
	});
});

describe("specsSignoff", () => {
	const done = (attempt: number) =>
		row({
			child: "S",
			attempt,
			stage: "result",
			status: "done",
			data: { head: `h${attempt}` },
		});
	const signed = (attempt: number, status: string, note?: string) =>
		row({
			child: "S",
			attempt,
			stage: "signoff",
			status,
			data: { by: "person", ...(note ? { note } : {}) },
		});

	it("has nothing before the spine is done", () => {
		expect(specsSignoff([], "S")).toBeUndefined();
	});

	it("waits on the sign-off of the spine's last done attempt", () => {
		expect(specsSignoff([done(1)], "S")).toEqual({
			signed: "none",
			attempt: 1,
			head: "h1",
		});
		// A sign-off of an earlier attempt does not cover a later one.
		expect(
			specsSignoff([done(1), signed(1, "approved"), done(2)], "S"),
		).toEqual({ signed: "none", attempt: 2, head: "h2" });
	});

	it("reads the yes or the no with its note", () => {
		expect(specsSignoff([done(1), signed(1, "approved")], "S")).toEqual({
			signed: "approved",
		});
		expect(
			specsSignoff([done(1), signed(1, "rejected", "assert F2 too")], "S"),
		).toEqual({ signed: "rejected", note: "assert F2 too" });
	});
});

describe("planApproved", () => {
	const approval = (status: string) =>
		row({ child: "P", attempt: 0, stage: "approval", status });

	it("needs the last approval to be a yes", () => {
		expect(planApproved([], "P")).toBe(false);
		expect(planApproved([approval("approved")], "P")).toBe(true);
		expect(
			planApproved([approval("approved"), approval("rejected")], "P"),
		).toBe(false);
	});

	it("takes a run that dispatched before approvals were recorded as approved", () => {
		expect(planApproved([row({ stage: "dispatched" })], "P")).toBe(true);
	});
});

describe("parkRepeats", () => {
	const park = (attempt: number, head = "h1", question = "Which route?") =>
		row({
			stage: "result",
			status: "parked",
			attempt,
			data: { head, message: question },
		});
	const scripted = (attempt: number) =>
		row({
			stage: "decision",
			status: "answer",
			attempt,
			data: { kind: "parked", by: "eval", answer: "Carry on." },
		});

	it("counts parks in a row on one head, through the script's answers", () => {
		const rows = [
			row({ stage: "dispatched" }),
			park(1),
			scripted(1),
			row({ stage: "dispatched", attempt: 2 }),
			park(2, "h1", "Still: which route?"),
		];
		expect(parkRepeats(rows, "A")).toEqual([
			{ attempt: 1, question: "Which route?" },
			{ attempt: 2, question: "Still: which route?" },
		]);
		expect(parkRepeats(rows, "B")).toEqual([]);
	});

	it("starts again after a new head, a finished result, a landing or a person's answer", () => {
		expect(parkRepeats([park(1, "h0"), park(2), park(3)], "A")).toHaveLength(2);
		expect(
			parkRepeats(
				[park(1), row({ stage: "result", status: "failed" }), park(3)],
				"A",
			),
		).toHaveLength(1);
		expect(
			parkRepeats([park(1), row({ stage: "landed" }), park(3)], "A"),
		).toHaveLength(1);
		const person = row({
			stage: "decision",
			status: "answer",
			data: { kind: "parked", by: "person", answer: "Wait for B." },
		});
		expect(parkRepeats([park(1), park(2), person, park(3)], "A")).toHaveLength(
			1,
		);
		const amended = row({ stage: "amend", status: "landed" });
		expect(parkRepeats([park(1), park(2), amended, park(3)], "A")).toHaveLength(
			1,
		);
	});

	const rebased = (from: string, to: string) =>
		row({ stage: "env", status: "rebased", attempt: 0, data: { from, to } });

	it("reproduces run 5: parks interleaved with rebases onto siblings' landings count as one head, and the third stops", () => {
		// Attempt 2 parks at its own commit; env up then rebases it onto a sibling's landing
		// before attempt 3, which parks at the rebased head, as do 4 and 5 after more landings.
		const rows = [
			row({ stage: "dispatched", attempt: 2 }),
			park(2, "571e1f9"),
			scripted(2),
			rebased("571e1f9", "d57bceb"),
			row({ stage: "dispatched", attempt: 3 }),
			park(3, "d57bceb", "May the spec be changed?"),
		];
		expect(parkRepeats(rows, "A").map((p) => p.attempt)).toEqual([2, 3]);
		const third = [
			...rows,
			scripted(3),
			rebased("d57bceb", "e000001"),
			row({ stage: "dispatched", attempt: 4 }),
			park(4, "e000001", "Or should bun change?"),
		];
		expect(parkRepeats(third, "A").map((p) => p.attempt)).toEqual([2, 3, 4]);
		expect(parkRepeats(third, "A")).toHaveLength(PARK_REPEATS);
	});

	it("still starts again after a commit of the worker's own on top of a rebase", () => {
		const rows = [
			park(1, "h1"),
			rebased("h1", "h2"),
			park(2, "h2"),
			park(3, "h3"),
		];
		expect(parkRepeats(rows, "A").map((p) => p.attempt)).toEqual([3]);
		// Another child's rebase is not this one's.
		expect(
			parkRepeats(
				[park(1, "h1"), { ...rebased("h1", "h2"), child: "B" }, park(2, "h2")],
				"A",
			),
		).toHaveLength(1);
	});
});

describe("childNext on a spec claim", () => {
	const claim = {
		path: "specs/launch/R6.accept.ts",
		scenario: "R6",
		assertion: "expect(Date.parse(res.body.launchedAt)).not.toBeNaN()",
		evidence: "line 17 fails whatever launch returns",
	};
	const claimed = row({
		stage: "result",
		status: "parked",
		attempt: 2,
		data: { head: "h1", message: "its spec cannot pass", spec: claim },
	});
	const base = [row({ stage: "dispatched", attempt: 2 }), claimed];

	it("waits on the amendment, neither asking nor restarting", () => {
		expect(childNext(base, "A", "parked")).toEqual({
			next: "amend",
			attempt: 2,
			claim,
		});
		const started = row({
			stage: "amend",
			status: "done",
			attempt: 2,
			data: { head: "a1" },
		});
		expect(childNext([...base, started], "A", "parked")).toMatchObject({
			next: "amend",
			claim: { amendment: { status: "done", head: "a1" } },
		});
	});

	it("restarts onto the amended spec once it has landed", () => {
		const landed = row({
			stage: "amend",
			status: "landed",
			attempt: 2,
			data: { commit: "abcdef1234" },
		});
		const n = childNext([...base, landed], "A", "parked");
		expect(n.next).toBe("restart");
		expect(n.next === "restart" && n.note).toContain(
			"specs/launch/R6.accept.ts was amended on the integration branch (abcdef1)",
		);
	});

	it("restarts with a person's answer, which settles the claim instead", () => {
		const answer = row({
			stage: "decision",
			status: "answer",
			attempt: 2,
			data: { kind: "parked", by: "person", answer: "The spec is right." },
		});
		expect(childNext([...base, answer], "A", "parked")).toEqual({
			next: "restart",
			note: "The spec is right.",
		});
	});
});

describe("childNext on a park a sibling may settle", () => {
	const siblings = [
		{ key: "A", touches: ["src/a/**"] },
		{ key: "B", touches: ["src/surcharge/**"] },
		{ key: "C", touches: ["src/c/**"] },
	];
	const parkedOn = (message: string, spec?: Record<string, string>) => [
		row({ stage: "dispatched", attempt: 2 }),
		row({
			stage: "result",
			status: "parked",
			attempt: 2,
			data: { head: "h1", message, ...(spec ? { spec } : {}) },
		}),
	];
	const landed = (child: string) => row({ child, stage: "landed" });

	it("goes again, asking no one, once a sibling it names lands after its dispatch", () => {
		const rows = [
			...parkedOn("src/surcharge/rules.ts still returns 0"),
			landed("B"),
		];
		const n = childNext(rows, "A", "parked", siblings);
		expect(n).toMatchObject({ next: "restart" });
		expect(n.next === "restart" && n.note).toContain("B landed after");
	});

	it("waits while the sibling it names is still running, then asks once that one stops", () => {
		const running = [
			row({ child: "B", stage: "dispatched" }),
			...parkedOn("this needs B's surcharge"),
		];
		expect(childNext(running, "A", "parked", siblings)).toEqual({
			next: "none",
		});
		const stopped = [
			...running,
			row({
				child: "B",
				stage: "result",
				status: "parked",
				data: { message: "?" },
			}),
		];
		expect(childNext(stopped, "A", "parked", siblings)).toMatchObject({
			next: "ask",
		});
	});

	it("asks as usual when what landed is not what it named, or landed before its dispatch", () => {
		const earlier = [landed("B"), ...parkedOn("B's surcharge is missing")];
		expect(childNext(earlier, "A", "parked", siblings)).toMatchObject({
			next: "ask",
		});
		const other = [...parkedOn("B's surcharge is missing"), landed("C")];
		expect(childNext(other, "A", "parked", siblings)).toMatchObject({
			next: "ask",
		});
	});

	it("re-checks a spec claim against any sibling that landed since, before an amendment starts", () => {
		const spec = {
			path: "s.ts",
			scenario: "R4",
			assertion: "x",
			evidence: "y",
		};
		const rows = [...parkedOn("cannot pass", spec), landed("C")];
		expect(childNext(rows, "A", "parked", siblings)).toMatchObject({
			next: "restart",
		});
		const started = [
			...rows,
			row({ stage: "amend", status: "started", attempt: 2 }),
		];
		expect(childNext(started, "A", "parked", siblings)).toMatchObject({
			next: "amend",
		});
	});
});

describe("childNext on a park asking for a landed child's file", () => {
	const siblings = [
		{ key: "S", touches: ["src/delivery/**", "src/orders/repo.ts"] },
		{ key: "O", touches: ["src/orders/**"] },
		{ key: "A", touches: ["src/refunds/**"] },
		{ key: "R", touches: ["src/receipt/**"] },
	];
	const ask =
		"R7 needs `refunded`, but src/orders/repo.ts is outside my touches (src/refunds/**). May I add it?";
	const landed = (child: string) => row({ child, stage: "landed" });
	const parked = (message = ask, attempt = 1) => [
		row({ stage: "dispatched", attempt }),
		row({
			stage: "result",
			status: "parked",
			attempt,
			data: { head: "h1", message },
		}),
	];

	it("grants the file and goes again, asking no one, when every owner has landed", () => {
		const rows = [landed("S"), landed("O"), ...parked()];
		const n = childNext(rows, "A", "parked", siblings);
		expect(n).toMatchObject({
			next: "restart",
			grant: { files: ["src/orders/repo.ts"], owners: ["S", "O"] },
		});
		expect(n.next === "restart" && n.note).toContain("src/orders/repo.ts");
	});

	it("asks while an owner of the file has not landed", () => {
		const rows = [landed("S"), ...parked()];
		expect(childNext(rows, "A", "parked", siblings)).toMatchObject({
			next: "ask",
		});
	});

	it("asks for a file no other child owns, a sensitive file, or one of its own", () => {
		const nobody = [
			landed("S"),
			landed("O"),
			...parked("May I edit src/billing/ledger.ts?"),
		];
		expect(childNext(nobody, "A", "parked", siblings)).toMatchObject({
			next: "ask",
		});
		const rows = [landed("S"), landed("O"), ...parked()];
		expect(
			childNext(rows, "A", "parked", siblings, {
				sensitive: (f) => f.startsWith("src/orders/"),
			}),
		).toMatchObject({ next: "ask" });
		const own = [
			landed("S"),
			landed("O"),
			...parked("src/refunds/repo.ts fails its typecheck"),
		];
		expect(childNext(own, "A", "parked", siblings)).toMatchObject({
			next: "ask",
		});
	});

	it("grants a file once: a park on it again goes to the person", () => {
		const rows = [
			landed("S"),
			landed("O"),
			...parked(),
			row({ stage: "grant", data: { files: ["src/orders/repo.ts"] } }),
			...parked(ask, 2),
		];
		expect(childNext(rows, "A", "parked", siblings)).toMatchObject({
			next: "ask",
		});
	});

	it("goes again on a grant already recorded for this park, granting nothing new", () => {
		const rows = [
			landed("S"),
			landed("O"),
			...parked(),
			row({ stage: "grant", data: { files: ["src/orders/repo.ts"] } }),
		];
		const n = childNext(rows, "A", "parked", siblings);
		expect(n).toMatchObject({ next: "restart" });
		expect(n.next === "restart" && n.grant).toBeFalsy();
	});

	it("leaves a spec claim to the amendment path", () => {
		const rows = [
			landed("S"),
			landed("O"),
			row({ stage: "dispatched" }),
			row({
				stage: "result",
				status: "parked",
				data: {
					head: "h1",
					message: ask,
					spec: { path: "s.ts", scenario: "R7", assertion: "x", evidence: "y" },
				},
			}),
		];
		expect(childNext(rows, "A", "parked", siblings)).toMatchObject({
			next: "amend",
		});
	});
});
