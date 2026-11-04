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

describe("a parked worker's suggested answers", () => {
	const park = {
		...good,
		status: "parked",
		gates: { task: "pass", exit: "fail" },
		question: "Which way?",
	};
	const parse = (extra: Record<string, unknown>) => {
		const r = parseResult(JSON.stringify({ ...park, ...extra }), "ACME-2");
		if (!r.ok) throw new Error(`a suggestion failed the result: ${r.error}`);
		return r.result;
	};
	it("keeps 2 to 4 options and the one recommended", () => {
		expect(parse({ options: ["a", "b"], recommended: 1 })).toMatchObject({
			options: ["a", "b"],
			recommended: 1,
		});
		expect(parse({ options: [" a ", "b", "c", "d"] }).options).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
		expect(parse({ options: ["a", "b"], recommended: 0 }).recommended).toBe(0);
	});
	const BAD: [string, Record<string, unknown>][] = [
		["a string", { options: "a, b" }],
		["an object", { options: { a: 1 } }],
		["a number", { options: 3 }],
		["null", { options: null }],
		["an empty list", { options: [] }],
		["one option", { options: ["only"] }],
		["all the wrong type", { options: [1, 2, 3] }],
		["all blank", { options: ["", "  ", "\n"] }],
		["one left of two", { options: ["a", ""] }],
		["one left of two types", { options: ["a", 2] }],
	];
	for (const [name, extra] of BAD)
		it(`drops ${name}, and never fails the result`, () => {
			const r = parse({ ...extra, recommended: 0 });
			expect(r.options).toBeUndefined();
			expect(r.recommended).toBeUndefined();
			expect(r.question).toBe("Which way?");
		});
	it("drops the bad entries among good ones", () => {
		expect(parse({ options: ["a", "", 3, null, "b"] }).options).toEqual([
			"a",
			"b",
		]);
	});
	it("keeps the first 4 of more", () => {
		const options = ["a", "b", "c", "d", "e", "f"];
		expect(parse({ options }).options).toEqual(["a", "b", "c", "d"]);
		expect(parse({ options, recommended: 4 }).recommended).toBeUndefined();
	});
	for (const bad of [2, -1, 0.5, "0", null, true, [0]])
		it(`drops recommended ${JSON.stringify(bad)}, keeping the options`, () => {
			const r = parse({ options: ["a", "b"], recommended: bad });
			expect(r.options).toEqual(["a", "b"]);
			expect(r.recommended).toBeUndefined();
		});
	it("keeps recommended on its own entry when one before it is dropped", () => {
		const r = parse({ options: ["", "a", "b"], recommended: 2 });
		expect(r.options).toEqual(["a", "b"]);
		expect(r.recommended).toBe(1);
		expect(
			parse({ options: ["", "a", "b"], recommended: 0 }).recommended,
		).toBeUndefined();
	});
	it("drops recommended alone, with no options", () => {
		expect(parse({ recommended: 0 }).recommended).toBeUndefined();
	});
	it("still rejects a key the result does not have", () => {
		expect(parseResult(JSON.stringify({ ...park, nope: 1 }), "ACME-2").ok).toBe(
			false,
		);
	});
});
