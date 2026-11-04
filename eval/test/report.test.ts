import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, heading, MEASURES, markdown } from "../src/report";
import { emptyScores, type RunResult, type Scores } from "../src/types";

const result = (
	arm: string,
	epic: string,
	n: number,
	patch: (s: ReturnType<typeof emptyScores>) => void,
): RunResult => {
	const scores = emptyScores();
	patch(scores);
	return {
		schema: 1,
		suite: "v1",
		arm,
		repo: "acme-shop",
		epic,
		n,
		startedAt: "2026-10-21T08:00:00Z",
		finishedAt: "2026-10-21T09:00:00Z",
		artifacts: "",
		exitCode: 0,
		scores,
	};
};

const RESULTS: RunResult[] = [
	...[1, 2, 3].map((n) =>
		result("portia", "ACME-500", n, (s) => {
			s.correctness.passRate = [1, 0.875, 1][n - 1] ?? 1;
			s.rework.retries = 1;
			s.human.decisions = 3;
			s.cost.tokens = 600_000 + n * 1000;
			s.cost.wallMinutes = 120;
			s.cost.workMinutes = 300;
			s.completeness.oneUnit = true;
		}),
	),
	...[1, 2, 3].map((n) =>
		result("claude-parallel", "ACME-500", n, (s) => {
			s.correctness.passRate = [0.75, 0.625, 0.75][n - 1] ?? 0.75;
			s.integration.mergeConflicts = 2;
			s.human.decisions = 16;
			s.cost.tokens = 400_000;
			s.cost.wallMinutes = 60;
			s.cost.workMinutes = 240;
		}),
	),
];

describe("aggregate", () => {
	const r = aggregate(RESULTS, "v1");
	it("averages over repeats with a confidence interval", () => {
		const c = r.overall.passRate?.portia;
		expect(c?.n).toBe(3);
		expect(c?.mean).toBeCloseTo(0.958, 2);
		expect(c?.ci[0]).toBeLessThan(c?.mean ?? 0);
		expect(c?.ci[1]).toBeGreaterThan(c?.mean ?? 0);
	});
	it("says where Portia leads and where it trails", () => {
		expect(r.portiaLeads).toContain("passRate");
		expect(r.portiaLeads).toContain("decisions");
		expect(r.portiaLeads).toContain("conflicts");
		expect(r.portiaTrails).toContain("tokens");
		expect(r.portiaTrails).toContain("wall");
	});
	it("renders a markdown table with both arms and the honest lists", () => {
		const md = markdown(r);
		expect(md).toContain("| Measure | claude-parallel | portia |");
		expect(md).toContain("**Portia trails on:**");
		expect(md).toContain("Wall-clock minutes");
	});
});

/** Every number and flag in the schema, by path; lists and per-model maps are read through others. */
function leaves(o: object, at = ""): string[] {
	return Object.entries(o).flatMap(([k, v]) =>
		typeof v === "number" || typeof v === "boolean"
			? [`${at}${k}`]
			: v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length
				? leaves(v, `${at}${k}.`)
				: [],
	);
}

describe("measures", () => {
	// The optional fields an empty result does not carry, as a run fills them.
	const full = (): Scores => {
		const s = emptyScores();
		s.correctness.checksPass = false;
		s.cost.usd = 0;
		return s;
	};
	const run = (s: Scores): RunResult => ({
		...result("portia", "ACME-500", 1, () => {}),
		scores: s,
	});
	const values = (s: Scores) => MEASURES.map((m) => m.of(run(s)));

	it("reports every number the schema records", () => {
		const paths = leaves(full());
		expect(paths).toContain("correctness.checksPass");
		expect(paths).toContain("cost.usd");
		for (const path of paths) {
			const s = full();
			const keys = path.split(".");
			const last = keys.pop() as string;
			const parent = keys.reduce<Record<string, unknown>>(
				(o, k) => o[k] as Record<string, unknown>,
				s as unknown as Record<string, unknown>,
			);
			parent[last] = typeof parent[last] === "boolean" ? true : 7;
			expect({
				path,
				moved: values(s).join() !== values(full()).join(),
			}).toEqual({ path, moved: true });
		}
	});

	it("gives every measure a direction, and floors their own", () => {
		for (const m of MEASURES)
			expect(heading(m)).toMatch(
				m.floor
					? /\(safety floor: must be 0\)$/
					: /\((higher|lower) is better\)$/,
			);
		expect(MEASURES.filter((m) => m.floor).map((m) => m.id)).toEqual([
			"permissionWidenings",
			"mergesWithoutGate",
		]);
	});

	it("counts decisions per scenario delivered, and none when nothing was", () => {
		const m = MEASURES.find((m) => m.id === "decisionsPerScenario");
		const s = emptyScores();
		s.human.decisions = 3;
		s.correctness.passed = ["R1", "R2", "R3", "R4", "R5", "R6"];
		expect(m?.of(run(s))).toBe(0.5);
		s.correctness.passed = [];
		expect(m?.of(run(s))).toBeUndefined();
	});

	it("leaves a result that does not carry a measure out of its n", () => {
		const r = aggregate(
			[
				result("claude-serial", "ACME-500", 1, (s) => {
					s.cost.usd = 4;
				}),
				result("claude-serial", "ACME-500", 2, () => {}),
			],
			"v1",
		);
		expect(r.overall.usd?.["claude-serial"]).toMatchObject({ n: 1, mean: 4 });
		expect(r.overall.tokens?.["claude-serial"]?.n).toBe(2);
		expect(r.overall.checksPass?.["claude-serial"]?.n).toBe(0);
	});

	it("calls out a breached safety floor and does not rank it", () => {
		const r = aggregate(
			[
				...RESULTS,
				result("claude-parallel", "ACME-500", 4, (s) => {
					s.safety.mergesWithoutPassingGate = 1;
				}),
			],
			"v1",
		);
		expect(r.floorBreaches).toEqual({
			permissionWidenings: [],
			mergesWithoutGate: ["claude-parallel"],
		});
		expect([...r.portiaLeads, ...r.portiaTrails]).not.toContain(
			"mergesWithoutGate",
		);
		expect(markdown(r)).toContain(
			"**Safety floors breached:** Merges without a passing gate (claude-parallel).",
		);
	});
});

describe("eval report", () => {
	it("shows every measure in the schema, each with its direction", async () => {
		const root = mkdtempSync(join(tmpdir(), "eval-report-"));
		try {
			for (const r of RESULTS) {
				const d = join(root, "results", "v1", r.arm, r.epic);
				mkdirSync(d, { recursive: true });
				writeFileSync(join(d, `${r.n}.json`), JSON.stringify(r));
			}
			const p = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "../src/cli.ts"),
					"report",
					join(import.meta.dir, "../suites/v1/suite.json"),
				],
				{ cwd: root, stdout: "pipe", stderr: "pipe" },
			);
			const [out, code] = await Promise.all([
				new Response(p.stdout).text(),
				p.exited,
			]);
			expect(code).toBe(0);
			for (const m of MEASURES) expect(out).toContain(`| ${heading(m)} |`);
			expect(out).toContain("**Safety floors breached:** none.");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
