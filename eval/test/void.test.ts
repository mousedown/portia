import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineFor, cachedFor, readLedger, record } from "../src/budget";
import { compareVersions, comparisonMarkdown } from "../src/compare";
import { aggregate, loadResults } from "../src/report";
import { emptyScores, type RunResult } from "../src/types";
import { voidRun } from "../src/void";

const SUITE = join(import.meta.dir, "../suites/v1/suite.json");
const CLI = join(import.meta.dir, "../src/cli.ts");

const result = (o: {
	n: number;
	sha: string;
	passRate: number;
	finishedAt?: string;
	void?: RunResult["void"];
}): RunResult => {
	const scores = emptyScores();
	scores.correctness.passRate = o.passRate;
	scores.cost.tokens = 100_000 * o.n;
	return {
		schema: 1,
		suite: "v1",
		arm: "portia",
		repo: "acme-shop",
		epic: "ACME-400",
		n: o.n,
		startedAt: "2026-10-29T08:00:00Z",
		finishedAt: o.finishedAt ?? "2026-10-29T09:00:00Z",
		artifacts: "",
		exitCode: 0,
		tools: {
			portia: { sha: o.sha },
			claude: "9.9.9",
			model: "sonnet",
			armVersion: o.sha,
		},
		scores,
		...(o.void ? { void: o.void } : {}),
	};
};

const broken = { reason: "the harness cut the session off", at: "2026-10-30" };

function saved(rs: RunResult[]) {
	const root = mkdtempSync(join(tmpdir(), "eval-void-"));
	const dir = join(root, "results", "v1", "portia", "ACME-400");
	mkdirSync(dir, { recursive: true });
	for (const r of rs)
		writeFileSync(join(dir, `${r.n}.json`), JSON.stringify(r, null, "\t"));
	return { root, dir };
}

describe("eval void", () => {
	it("marks the saved result void with why and when, and keeps the rest of it", () => {
		const r = result({ n: 2, sha: "aaaa1111", passRate: 1 });
		const { root, dir } = saved([r]);
		record(root, {
			at: r.finishedAt,
			suite: "v1",
			arm: "portia",
			epic: "ACME-400",
			n: 2,
			tokens: 200_000,
		});
		const now = new Date("2026-10-30T10:00:00Z");
		voidRun({
			root,
			suite: "v1",
			arm: "portia",
			epic: "ACME-400",
			n: 2,
			reason: "  scoring crashed  ",
			now,
		});
		const after = JSON.parse(readFileSync(join(dir, "2.json"), "utf8"));
		expect(after).toEqual({
			...r,
			void: { reason: "scoring crashed", at: now.toISOString() },
		});
		expect(loadResults(root, "v1")).toHaveLength(1);
		expect(readLedger(root).map((e) => e.tokens)).toEqual([200_000]);
	});

	it("refuses a run with no result file, or no reason", () => {
		const { root } = saved([result({ n: 1, sha: "a", passRate: 1 })]);
		const o = { root, suite: "v1", arm: "portia", epic: "ACME-400" };
		expect(() => voidRun({ ...o, n: 9, reason: "x" })).toThrow(
			"no result for run 9 of portia on ACME-400",
		);
		expect(() => voidRun({ ...o, n: 1, reason: " " })).toThrow("--reason");
	});

	it("is a command that names the run and prints its void", async () => {
		const { root, dir } = saved([result({ n: 1, sha: "a", passRate: 1 })]);
		const p = Bun.spawn(
			[
				process.execPath,
				CLI,
				"void",
				SUITE,
				"--arm",
				"portia",
				"--epic",
				"ACME-400",
				"--n",
				"1",
				"--reason",
				"an unanswered question",
			],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const out = await new Response(p.stdout).text();
		expect(await p.exited).toBe(0);
		expect(JSON.parse(out)).toMatchObject({
			arm: "portia",
			epic: "ACME-400",
			n: 1,
			void: { reason: "an unanswered question" },
		});
		expect(
			JSON.parse(readFileSync(join(dir, "1.json"), "utf8")).void.reason,
		).toBe("an unanswered question");
	});
});

describe("a void result", () => {
	const rs = [
		result({ n: 1, sha: "aaaa1111", passRate: 0, void: broken }),
		result({ n: 2, sha: "aaaa1111", passRate: 1 }),
		result({ n: 3, sha: "bbbb2222", passRate: 1 }),
		result({
			n: 4,
			sha: "cccc3333",
			passRate: 0,
			finishedAt: "2026-10-30T09:00:00Z",
			void: broken,
		}),
	];

	it("is left out of the report", () => {
		const r = aggregate(rs, "v1");
		expect(r.overall.passRate?.portia).toMatchObject({ n: 2, mean: 1 });
	});

	it("is left out of a comparison, and counted", () => {
		const c = compareVersions(rs, "portia", "aaaa", "bbbb");
		expect(c.before.n).toBe(1);
		expect(c.after.n).toBe(1);
		expect(c.voided).toBe(1);
		expect(c.rows.find((r) => r.id === "passRate")?.before.mean).toBe(1);
		expect(comparisonMarkdown(c)).toContain(
			"1 void result(s) for portia on these commits were left out.",
		);
	});

	it("never stands in for a cached repeat or a stop-if-worse baseline", () => {
		const key = {
			arm: "portia",
			armVersion: "aaaa1111",
			model: "sonnet",
			suite: "v1",
			epic: "ACME-400",
		};
		expect(cachedFor(rs, key).map((r) => r.n)).toEqual([2]);
		expect(cachedFor(rs, { ...key, armVersion: "cccc3333" })).toEqual([]);
		// cccc3333 finished last, but only void results carry it: bbbb2222 is the baseline.
		expect(baselineFor(rs, key).map((r) => r.n)).toEqual([3]);
	});
});
