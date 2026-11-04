import { describe, expect, it } from "bun:test";
import { compareVersions, comparisonMarkdown } from "../src/compare";
import { emptyScores, type RunResult } from "../src/types";

const run = (
	sha: string | undefined,
	n: number,
	retries: number,
	tokens: number,
	pass: number,
): RunResult => {
	const scores = emptyScores();
	scores.rework.retries = retries;
	scores.cost.tokens = tokens;
	scores.correctness.passRate = pass;
	return {
		schema: 1,
		suite: "v1",
		arm: "portia",
		repo: "acme-shop",
		epic: "ACME-500",
		n,
		startedAt: "",
		finishedAt: "",
		artifacts: "",
		exitCode: 0,
		scores,
		tools: sha ? { portia: { sha }, claude: "2.1.0" } : undefined,
	};
};

describe("compareVersions", () => {
	const results = [
		run("aaaa1111", 1, 3, 900_000, 0.875),
		run("aaaa1111", 2, 2, 850_000, 1),
		run("bbbb2222", 1, 1, 600_000, 1),
		run("bbbb2222", 2, 1, 650_000, 1),
		run(undefined, 3, 9, 1, 0),
	];
	const c = compareVersions(results, "portia", "aaaa", "bbbb");
	it("matches a sha prefix and leaves unversioned results out", () => {
		expect(c.before.n).toBe(2);
		expect(c.after.n).toBe(2);
		expect(c.unversioned).toBe(1);
	});
	it("gives the delta in the measure's better direction", () => {
		const retries = c.rows.find((r) => r.id === "retries");
		expect(retries?.before.mean).toBe(2.5);
		expect(retries?.after.mean).toBe(1);
		expect(retries?.delta).toBe(-1.5);
		expect(retries?.pct).toBeCloseTo(-0.6);
		expect(retries?.improved).toBe(true);
		const pass = c.rows.find((r) => r.id === "passRate");
		expect(pass?.improved).toBe(true);
	});
	it("renders a before/after table", () => {
		const md = comparisonMarkdown(c);
		expect(md).toContain("aaaa1111 (n=2) → bbbb2222 (n=2)");
		expect(md).toContain("| Retries | 2.50 | 1.00 | -1.50 (-60%) | better |");
		expect(md).toContain("1 result(s) for portia carry no Portia sha");
	});
});
