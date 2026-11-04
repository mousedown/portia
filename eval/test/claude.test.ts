import { describe, expect, it } from "bun:test";
import { parseSessionResult } from "../src/arms/claude";
import { outsideDeclared } from "../src/metrics/git";
import { ci95, mean, sd } from "../src/metrics/time";

describe("parseSessionResult", () => {
	it("reads tokens, per-model usage and cost from Claude Code's JSON result", () => {
		const out = `${JSON.stringify({
			type: "result",
			result: "done",
			total_cost_usd: 1.25,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_read_input_tokens: 85,
			},
			modelUsage: {
				"claude-opus": {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 85,
				},
			},
		})}\n`;
		const r = parseSessionResult(out);
		expect(r.tokens).toBe(100);
		expect(r.usd).toBe(1.25);
		expect(r.tokensByModel).toEqual({ "claude-opus": 100 });
		expect(r.result).toBe("done");
	});
	it("keeps the text when the output is not JSON", () => {
		const r = parseSessionResult("not json");
		expect(r.tokens).toBe(0);
		expect(r.result).toBe("not json");
	});
});

describe("outsideDeclared", () => {
	it("lists files no child declared", () => {
		const kids = [
			{ touches: ["src/a/**"] },
			{ touches: ["src/b/**", "specs/b/**"] },
		];
		expect(
			outsideDeclared(
				["src/a/x.ts", "src/b/y.ts", "src/c/z.ts", "README.md"],
				kids,
			),
		).toEqual(["src/c/z.ts", "README.md"]);
	});
	it("declares nothing when no child declares anything", () => {
		expect(outsideDeclared(["anything"], [])).toEqual([]);
	});
});

describe("statistics", () => {
	it("mean, sd and a t-based 95% interval", () => {
		const xs = [2, 4, 4, 4, 5, 5, 7, 9];
		expect(mean(xs)).toBe(5);
		expect(sd(xs)).toBeCloseTo(2.138, 3);
		const [lo, hi] = ci95(xs);
		expect(lo).toBeCloseTo(5 - 2.365 * (2.138 / Math.sqrt(8)), 2);
		expect(hi).toBeCloseTo(5 + 2.365 * (2.138 / Math.sqrt(8)), 2);
	});
});
