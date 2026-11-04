import { describe, expect, it } from "vitest";
import { parseResult } from "../../src/result/parse";

const good = {
	child: "ACME-2",
	status: "done",
	head: "abc1234",
	gates: { task: "pass", exit: "pass" },
	evidence: { F1: "bun run test: 12 passed" },
};
const FENCE = "`".repeat(3);

describe("parseResult (Review focus 2)", () => {
	it("accepts exactly one object, bare or fenced", () => {
		expect(parseResult(JSON.stringify(good), "ACME-2")).toMatchObject({
			ok: true,
			result: { status: "done" },
		});
		expect(
			parseResult(`${FENCE}json\n${JSON.stringify(good)}\n${FENCE}`, "ACME-2")
				.ok,
		).toBe(true);
	});
	it("rejects prose around the object", () => {
		expect(parseResult(`All done! ${JSON.stringify(good)}`, "ACME-2")).toEqual({
			ok: false,
			error: "the worker's last message is not exactly one JSON object",
		});
	});
	it("rejects two objects and truncated JSON", () => {
		expect(
			parseResult(`${JSON.stringify(good)}\n${JSON.stringify(good)}`, "ACME-2")
				.ok,
		).toBe(false);
		expect(parseResult(JSON.stringify(good).slice(0, 40), "ACME-2").ok).toBe(
			false,
		);
	});
	it("enforces the status rules", () => {
		expect(
			parseResult(JSON.stringify({ ...good, status: "parked" }), "ACME-2"),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("needs a question"),
		});
		expect(
			parseResult(
				JSON.stringify({ ...good, gates: { task: "pass", exit: "fail" } }),
				"ACME-2",
			),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("both gates"),
		});
		expect(
			parseResult(JSON.stringify({ ...good, extra: 1 }), "ACME-2").ok,
		).toBe(false);
	});
	it("rejects a result for another child", () => {
		expect(parseResult(JSON.stringify(good), "ACME-3")).toEqual({
			ok: false,
			error: "the result is for ACME-2, expected ACME-3",
		});
	});
});

describe("a claim that a spec cannot pass", () => {
	const spec = {
		path: "specs/launch/R6.accept.ts",
		assertion: "expect(Date.parse(res.body.launchedAt)).not.toBeNaN()",
		evidence: "line 17 fails whatever launch returns",
	};
	const parked = {
		...good,
		status: "parked",
		gates: { task: "pass", exit: "fail" },
		spec,
	};
	it("is taken on a park, with or without a question, and on a failure", () => {
		expect(parseResult(JSON.stringify(parked), "ACME-2")).toMatchObject({
			ok: true,
			result: { status: "parked", spec },
		});
		expect(
			parseResult(
				JSON.stringify({ ...parked, status: "failed", reason: "spec" }),
				"ACME-2",
			).ok,
		).toBe(true);
	});
	it("is refused on a done result, or without its evidence", () => {
		expect(
			parseResult(JSON.stringify({ ...good, spec }), "ACME-2"),
		).toMatchObject({ ok: false });
		expect(
			parseResult(
				JSON.stringify({ ...parked, spec: { ...spec, evidence: "" } }),
				"ACME-2",
			).ok,
		).toBe(false);
	});
});
