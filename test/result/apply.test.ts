import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { testProfile } from "../../src/core/config";
import { readRows } from "../../src/core/runlog";
import { applyOutcome } from "../../src/result/apply";
import { fakeExec } from "../helpers/fake-exec";
import { FakeTracker } from "../support/fake-tracker";

const setup = (changed: string, head = "abc1234fff") => {
	const dir = mkdtempSync(join(tmpdir(), "portia-res-"));
	writeFileSync(
		join(dir, "env-ACME-2.json"),
		JSON.stringify({
			worktree: "/wt/ACME-2",
			branch: "portia/ACME-2",
			db: "d",
			port: 1,
			envFile: "/x",
		}),
	);
	const { exec } = fakeExec((c) =>
		c.args[0] === "rev-parse"
			? { stdout: `${head}\n` }
			: c.args[0] === "diff"
				? { stdout: changed }
				: undefined,
	);
	const tracker = new FakeTracker().add({
		key: "ACME-2",
		summary: "x",
		description: "",
		blockedBy: [],
	});
	return {
		dir,
		tracker,
		ctx: {
			exec,
			profile: testProfile(),
			dir,
			parent: "ACME-0",
			tracker,
			touches: ["packages/acme-web/src/lib/onboarding/**"],
			attempt: 1,
			requestedModel: "sonnet",
		},
	};
};
const done = {
	ok: true as const,
	result: {
		child: "ACME-2",
		status: "done" as const,
		head: "abc1234",
		gates: { task: "pass" as const, exit: "pass" as const },
		evidence: { F1: "ok" },
	},
};

it("records a done result with touches matched", async () => {
	const s = setup("packages/acme-web/src/lib/onboarding/a.ts\n");
	expect(await applyOutcome(done, "ACME-2", s.ctx)).toMatchObject({
		status: "done",
		duplicate: false,
		outside: [],
	});
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		stage: "result",
		status: "done",
		touchesMatched: true,
		model: { requested: "sonnet" },
	});
	expect(s.tracker.writes[0]).toMatchObject({
		kind: "comment",
		key: "ACME-2",
	});
	expect(JSON.stringify(s.tracker.writes[0])).toContain("done");
	expect(s.tracker.writes[0]).toMatchObject({
		text: expect.stringMatching(/^Attempt 1: done\./),
	});
	expect(JSON.stringify(s.tracker.writes[0])).not.toMatch(/portia/i);
});

it("parks a done result that wrote outside its touches", async () => {
	const s = setup(
		"packages/acme-web/src/lib/onboarding/a.ts\npackages/acme-web/src/app/page.tsx\n",
	);
	expect(await applyOutcome(done, "ACME-2", s.ctx)).toMatchObject({
		status: "parked",
		outside: ["packages/acme-web/src/app/page.tsx"],
	});
});

it("fails a result whose head is not the worktree HEAD", async () => {
	const s = setup("", "9999999aaa");
	expect((await applyOutcome(done, "ACME-2", s.ctx)).status).toBe("failed");
});

it("records an unparseable message as failed, and acts on each attempt once", async () => {
	const s = setup("");
	const bad = {
		ok: false as const,
		error: "the worker's last message is not exactly one JSON object",
	};
	expect(await applyOutcome(bad, "ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		duplicate: false,
	});
	expect(await applyOutcome(done, "ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		duplicate: true,
	});
	expect(readRows(s.dir).rows.filter((r) => r.stage === "result")).toHaveLength(
		1,
	);
	expect(s.tracker.writes).toHaveLength(1);
});

it("two reconcilers applying one attempt at once record it once", async () => {
	const s = setup("packages/acme-web/src/app/page.tsx\n");
	let calls = 0;
	const ctx = {
		...s.ctx,
		// Both pass the first check, then wait on a slow touches decision.
		decideTouches: async () => {
			const answer = calls++ === 0 ? "accept" : "park";
			await new Promise((r) => setTimeout(r, 20));
			return answer as "accept" | "park";
		},
	};
	const [a, b] = await Promise.all([
		applyOutcome(done, "ACME-2", ctx),
		applyOutcome(done, "ACME-2", ctx),
	]);
	expect(calls).toBe(2);
	expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
	const rows = readRows(s.dir).rows.filter((r) => r.stage === "result");
	expect(rows).toHaveLength(1);
	// The duplicate reports the row that was recorded, not its own verdict.
	expect(a.status).toBe(rows[0]?.status);
	expect(b.status).toBe(rows[0]?.status);
	expect(s.tracker.writes).toHaveLength(1);
});

it("a tracker that cannot take the comment leaves the result recorded", async () => {
	const s = setup("packages/acme-web/src/lib/onboarding/a.ts\n");
	const err = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const applied = await applyOutcome(done, "ACME-2", {
			...s.ctx,
			tracker: { comment: () => Promise.reject(new Error("tracker 502")) },
		});
		expect(applied).toMatchObject({ status: "done", duplicate: false });
		expect(String(err.mock.calls[0]?.[0])).toContain("tracker 502");
	} finally {
		err.mockRestore();
	}
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({ stage: "result" });
});

it("tells the person the moment a park is recorded, once per attempt", async () => {
	const s = setup("packages/acme-web/src/lib/onboarding/a.ts\n");
	const parks: { question: string; attempt: number }[] = [];
	const ctx = {
		...s.ctx,
		onPark: async (p: { question: string; attempt: number }) => {
			// The row is already written when the person hears of it.
			expect(readRows(s.dir).rows.at(-1)).toMatchObject({ status: "parked" });
			parks.push(p);
		},
	};
	const question = {
		ok: true as const,
		result: {
			...done.result,
			status: "parked" as const,
			question: "Which colour should the button be?",
		},
	};
	await applyOutcome(question, "ACME-2", ctx);
	await applyOutcome(question, "ACME-2", ctx);
	expect(parks).toEqual([
		{ question: "Which colour should the button be?", attempt: 1 },
	]);
	await applyOutcome(done, "ACME-2", { ...ctx, attempt: 2 });
	expect(parks).toHaveLength(1);
	// A park for files outside its touches is put to the person too.
	const outside = setup("db/x.sql\n");
	const asked: unknown[] = [];
	await applyOutcome(done, "ACME-2", {
		...outside.ctx,
		onPark: async (p) => {
			asked.push(p);
		},
	});
	expect(asked).toEqual([
		{ question: "touched files outside its Touches: db/x.sql", attempt: 1 },
	]);
});

it("accepts a done result whose only files outside its touches are test ripples, and records them", async () => {
	const s = setup(
		"packages/acme-web/src/lib/onboarding/a.ts\npackages/acme-web/test/onboarding/a.test.ts\n",
	);
	const asked: string[][] = [];
	const applied = await applyOutcome(done, "ACME-2", {
		...s.ctx,
		decideTouches: async (outside) => {
			asked.push(outside);
			return "park";
		},
	});
	expect(applied).toMatchObject({
		status: "done",
		outside: ["packages/acme-web/test/onboarding/a.test.ts"],
	});
	expect(asked, "a ripple needs no decision").toEqual([]);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		status: "done",
		touchesMatched: false,
		ripples: [
			{ file: "packages/acme-web/test/onboarding/a.test.ts", kind: "test" },
		],
	});
});

it("asks only about the production file, and records the ripple beside it once accepted", async () => {
	const s = setup(
		"packages/acme-web/src/app/page.tsx\npackages/acme-web/test/a.test.ts\n",
	);
	const asked: string[][] = [];
	const applied = await applyOutcome(done, "ACME-2", {
		...s.ctx,
		decideTouches: async (outside) => {
			asked.push(outside);
			return "accept";
		},
	});
	expect(applied.status).toBe("done");
	expect(asked).toEqual([["packages/acme-web/src/app/page.tsx"]]);
	expect(readRows(s.dir).rows.at(-1)?.ripples).toEqual([
		{ file: "packages/acme-web/test/a.test.ts", kind: "test" },
	]);
});

it("parks on a spec a sibling in the wave touches without asking, whatever the decision would be", async () => {
	const s = setup("packages/acme-web/test/ledger/csv.test.ts\n");
	const applied = await applyOutcome(done, "ACME-2", {
		...s.ctx,
		siblings: [
			{ key: "ACME-3", touches: ["packages/acme-web/test/ledger/**"] },
		],
		decideTouches: async () => "accept",
	});
	expect(applied).toMatchObject({
		status: "parked",
		message:
			"touched files outside its Touches: packages/acme-web/test/ledger/csv.test.ts (in ACME-3's touches)",
	});
	expect(readRows(s.dir).rows.at(-1)?.ripples).toBeUndefined();
});

it("parks a claim that its own spec cannot pass, failure or park, with the claim on the row", async () => {
	const spec = {
		path: "./specs/launch/R6.accept.ts",
		assertion: "expect(Date.parse(res.body.launchedAt)).not.toBeNaN()",
		evidence: "line 17 fails whatever launch returns",
	};
	const s = setup("packages/acme-web/src/lib/onboarding/a.ts\n");
	const failed = {
		ok: true as const,
		result: {
			...done.result,
			status: "failed" as const,
			gates: { task: "pass" as const, exit: "fail" as const },
			reason: "R6 cannot pass",
			spec,
		},
	};
	const owned = [{ id: "R6", path: "specs/launch/R6.accept.ts" }];
	const a = await applyOutcome(failed, "ACME-2", { ...s.ctx, owned });
	expect(a.status).toBe("parked");
	expect(a.message).toMatch(
		/^its acceptance spec specs\/launch\/R6.accept.ts \(R6\) cannot pass as written/,
	);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		status: "parked",
		data: {
			spec: { ...spec, path: "specs/launch/R6.accept.ts", scenario: "R6" },
		},
	});
});

it("takes a claim on another child's spec as an ordinary outcome", async () => {
	const s = setup("packages/acme-web/src/lib/onboarding/a.ts\n");
	const parked = {
		ok: true as const,
		result: {
			...done.result,
			status: "parked" as const,
			gates: { task: "pass" as const, exit: "fail" as const },
			spec: {
				path: "specs/refunds/R7.accept.ts",
				assertion: "x",
				evidence: "y",
			},
		},
	};
	const a = await applyOutcome(parked, "ACME-2", {
		...s.ctx,
		owned: [{ id: "R6", path: "specs/launch/R6.accept.ts" }],
	});
	expect(a.status).toBe("parked");
	expect(a.message).toContain("not an acceptance spec of its own scenarios");
	expect(readRows(s.dir).rows.at(-1)?.data?.spec).toBeUndefined();
});
