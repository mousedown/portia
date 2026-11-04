import { describe, expect, it } from "vitest";
import { specRun } from "../../src/gate/satisfiable";

const SPEC = "specs/launch/R6.accept.ts";

describe("specRun", () => {
	it("takes a failing expect() as an assertion about missing behaviour", () => {
		const out = [
			"specs/launch/R6.accept.ts:",
			"15 |   const res = await post(launchRoute);",
			"16 |   expect(res.status).toBe(200);",
			"error: expect(received).toBe(expected)",
			"Expected: 200",
			"Received: 404",
			"      at <anonymous> (/wt/specs/launch/R6.accept.ts:16:22)",
			" 0 pass",
			" 2 fail",
		].join("\n");
		expect(specRun(SPEC, 1, out)).toEqual({ kind: "assertion" });
	});

	it("flags an error thrown by the test code, named by its own frame", () => {
		const out = [
			"TypeError: undefined is not an object (evaluating 'res.body.items.map')",
			"      at <anonymous> (/wt/specs/launch/R6.accept.ts:18:5)",
		].join("\n");
		expect(specRun(SPEC, 1, out)).toMatchObject({
			kind: "error",
			line: expect.stringContaining("TypeError"),
		});
		expect(
			specRun(
				SPEC,
				1,
				"error: Matcher error: received value must be a non-null object\n  at (specs/launch/R6.accept.ts:9:3)",
			).kind,
		).toBe("error");
	});

	it("does not take an error the system under test logged for one in the spec", () => {
		const out = [
			"[server] TypeError: cannot read properties of undefined",
			"      at handler (/wt/src/launch/route.ts:4:1)",
			"      at serve (/wt/src/app.ts:30:2)",
			"error: expect(received).toBe(expected)",
		].join("\n");
		expect(specRun(SPEC, 1, out).kind).toBe("assertion");
	});

	it("flags a spec that fails to load, before it reaches the system under test", () => {
		expect(
			specRun(
				SPEC,
				1,
				"error: Cannot find module '../../src/launch' from '/wt/specs/launch/R6.accept.ts'",
			).kind,
		).toBe("load");
		expect(specRun(SPEC, 1, "SyntaxError: Unexpected token '}'").kind).toBe(
			"load",
		);
		expect(
			specRun(
				SPEC,
				1,
				"# Unhandled error between tests\n-------------------------------",
			).kind,
		).toBe("load");
	});

	it("reports a spec that passes already", () => {
		expect(specRun(SPEC, 0, "2 pass")).toEqual({ kind: "passes" });
	});
});
