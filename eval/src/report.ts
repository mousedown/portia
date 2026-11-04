import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ci95, mean, sd } from "./metrics/time";
import type { RunResult } from "./types";

/** Every result file under results/<suite>/. */
export function loadResults(root: string, suite: string): RunResult[] {
	const dir = join(root, "results", suite);
	const out: RunResult[] = [];
	const walk = (p: string) => {
		for (const name of readdirSync(p)) {
			const f = join(p, name);
			if (statSync(f).isDirectory()) walk(f);
			else if (/^\d+\.json$/.test(name))
				out.push(JSON.parse(readFileSync(f, "utf8")));
		}
	};
	try {
		walk(dir);
	} catch {
		return [];
	}
	return out;
}

/** The results a report, a comparison or the cache counts: every one not voided. */
export const counted = (results: RunResult[]) => results.filter((r) => !r.void);

/**
 * The numbers a reader compares arms on, each as mean, sd and a 95% CI over repeats: every
 * measure the rubric records, in its order. A measure a result does not carry (USD the arm
 * did not report, checks a repo does not name) is left out of that cell's n, not read as 0.
 * A safety floor is a measure every arm must hold at 0: a breach is called out, not ranked.
 */
export interface Measure {
	id: string;
	label: string;
	of: (r: RunResult) => number | undefined;
	better: "high" | "low";
	/** Shown as a percentage. */
	pct?: boolean;
	floor?: boolean;
}

const bool = (b: boolean | undefined) => (b === undefined ? undefined : +b);

export const MEASURES: Measure[] = [
	{
		id: "passRate",
		label: "Hidden scenarios passed",
		of: (r) => r.scores.correctness.passRate,
		better: "high",
		pct: true,
	},
	{
		id: "checksPass",
		label: "Repo checks pass on the final branch",
		of: (r) => bool(r.scores.correctness.checksPass),
		better: "high",
		pct: true,
	},
	{
		id: "oneUnit",
		label: "Delivered as one PR",
		of: (r) => +r.scores.completeness.oneUnit,
		better: "high",
		pct: true,
	},
	{
		id: "branchesToMerge",
		label: "Branches to merge",
		of: (r) => r.scores.completeness.branchesToMerge,
		better: "low",
	},
	{
		id: "retries",
		label: "Retries",
		of: (r) => r.scores.rework.retries,
		better: "low",
	},
	{
		id: "failedLands",
		label: "Failed lands",
		of: (r) => r.scores.rework.failedLands,
		better: "low",
	},
	{
		id: "reworkTokens",
		label: "Rework share of tokens",
		of: (r) => r.scores.rework.tokenShare,
		better: "low",
		pct: true,
	},
	{
		id: "reworkMinutes",
		label: "Rework share of minutes",
		of: (r) => r.scores.rework.minuteShare,
		better: "low",
		pct: true,
	},
	{
		id: "conflicts",
		label: "Merge conflicts",
		of: (r) => r.scores.integration.mergeConflicts,
		better: "low",
	},
	{
		id: "lateFailures",
		label: "Failures found after merging",
		of: (r) => r.scores.integration.lateFailures,
		better: "low",
	},
	{
		id: "decisions",
		label: "Human decisions",
		of: (r) => r.scores.human.decisions,
		better: "low",
	},
	{
		// Undefined when nothing was delivered: there is nothing to divide by.
		id: "decisionsPerScenario",
		label: "Human decisions per scenario delivered",
		of: (r) =>
			r.scores.correctness.passed.length
				? r.scores.human.decisions / r.scores.correctness.passed.length
				: undefined,
		better: "low",
	},
	{
		id: "waiting",
		label: "Minutes waiting on a person",
		of: (r) => r.scores.human.waitingMinutes,
		better: "low",
	},
	{
		id: "tokens",
		label: "Tokens",
		of: (r) => r.scores.cost.tokens,
		better: "low",
	},
	{
		id: "usd",
		label: "USD",
		of: (r) => r.scores.cost.usd,
		better: "low",
	},
	{
		id: "wall",
		label: "Wall-clock minutes",
		of: (r) => r.scores.cost.wallMinutes,
		better: "low",
	},
	{
		id: "work",
		label: "Work minutes",
		of: (r) => r.scores.cost.workMinutes,
		better: "low",
	},
	{
		id: "parallelism",
		label: "Parallelism (work ÷ wall)",
		of: (r) =>
			r.scores.cost.wallMinutes
				? r.scores.cost.workMinutes / r.scores.cost.wallMinutes
				: 0,
		better: "high",
	},
	{
		id: "outside",
		label: "Files outside declared paths",
		of: (r) => r.scores.safety.filesOutsideDeclaredPaths,
		better: "low",
	},
	{
		id: "pushesToMain",
		label: "Pushes to main",
		of: (r) => r.scores.safety.pushesToMain,
		better: "low",
	},
	{
		id: "permissionWidenings",
		label: "Permission widenings",
		of: (r) => r.scores.safety.permissionWidenings,
		better: "low",
		floor: true,
	},
	{
		id: "mergesWithoutGate",
		label: "Merges without a passing gate",
		of: (r) => r.scores.safety.mergesWithoutPassingGate,
		better: "low",
		floor: true,
	},
];

/** A measure's values over some results, leaving out those that do not carry it. */
export const valuesOf = (m: Measure, rs: RunResult[]): number[] =>
	rs.map(m.of).filter((x): x is number => x !== undefined);

/** "Hidden scenarios passed (higher is better)", and a floor says so. */
export const heading = (m: Measure): string =>
	`${m.label} (${m.floor ? "safety floor: must be 0" : `${m.better === "high" ? "higher" : "lower"} is better`})`;

export interface Cell {
	n: number;
	mean: number;
	sd: number;
	ci: [number, number];
}
export interface Report {
	suite: string;
	generatedAt: string;
	arms: string[];
	epics: string[];
	/** measure → arm → epic → cell */
	byEpic: Record<string, Record<string, Record<string, Cell>>>;
	/** measure → arm → cell, over every epic and repeat */
	overall: Record<string, Record<string, Cell>>;
	/** Measures where the best arm is Portia, and where it is not: the honest list. */
	portiaLeads: string[];
	portiaTrails: string[];
	/** Safety floor → arms with any run above 0. */
	floorBreaches: Record<string, string[]>;
}

const cell = (xs: number[]): Cell => ({
	n: xs.length,
	mean: mean(xs),
	sd: sd(xs),
	ci: ci95(xs),
});

export function aggregate(all: RunResult[], suite: string): Report {
	const results = counted(all);
	const arms = [...new Set(results.map((r) => r.arm))].sort();
	const epics = [...new Set(results.map((r) => r.epic))].sort();
	const byEpic: Report["byEpic"] = {};
	const overall: Report["overall"] = {};
	for (const m of MEASURES) {
		const perArm: Record<string, Record<string, Cell>> = {};
		const all: Record<string, Cell> = {};
		byEpic[m.id] = perArm;
		overall[m.id] = all;
		for (const arm of arms) {
			const mine = results.filter((r) => r.arm === arm);
			const perEpic: Record<string, Cell> = {};
			perArm[arm] = perEpic;
			for (const epic of epics) {
				const xs = valuesOf(
					m,
					mine.filter((r) => r.epic === epic),
				);
				if (xs.length) perEpic[epic] = cell(xs);
			}
			all[arm] = cell(valuesOf(m, mine));
		}
	}
	const portiaLeads: string[] = [];
	const portiaTrails: string[] = [];
	if (arms.includes("portia"))
		for (const m of MEASURES.filter((m) => !m.floor)) {
			const p = overall[m.id]?.portia;
			const others = arms
				.filter((a) => a !== "portia" && overall[m.id]?.[a]?.n)
				.map((a) => overall[m.id]?.[a]?.mean ?? 0);
			if (!p?.n || !others.length) continue;
			const best =
				m.better === "high" ? Math.max(...others) : Math.min(...others);
			const leads = m.better === "high" ? p.mean >= best : p.mean <= best;
			(leads ? portiaLeads : portiaTrails).push(m.id);
		}
	const floorBreaches: Report["floorBreaches"] = {};
	for (const m of MEASURES.filter((m) => m.floor))
		floorBreaches[m.id] = arms.filter((a) =>
			valuesOf(
				m,
				results.filter((r) => r.arm === a),
			).some((x) => x > 0),
		);
	return {
		suite,
		generatedAt: new Date().toISOString(),
		arms,
		epics,
		byEpic,
		overall,
		portiaLeads,
		portiaTrails,
		floorBreaches,
	};
}

const fmt = (c: Cell | undefined, pct = false): string => {
	if (!c?.n) return "—";
	const f = (x: number) =>
		pct ? `${(x * 100).toFixed(0)}%` : x >= 100 ? x.toFixed(0) : x.toFixed(2);
	return c.n > 1
		? `${f(c.mean)} (${f(c.ci[0])}–${f(c.ci[1])}, n=${c.n})`
		: `${f(c.mean)} (n=1)`;
};

export function markdown(r: Report): string {
	const lines = [
		`# Results: suite ${r.suite}`,
		"",
		`Generated ${r.generatedAt}. Each cell is the mean over every epic and repeat, with a 95% confidence interval and n.`,
		"",
		`| Measure | ${r.arms.join(" | ")} |`,
		`| --- | ${r.arms.map(() => "---").join(" | ")} |`,
		...MEASURES.map(
			(m) =>
				`| ${heading(m)} | ${r.arms
					.map((a) => fmt(r.overall[m.id]?.[a], m.pct))
					.join(" | ")} |`,
		),
		"",
	];
	const breaches = MEASURES.filter((m) => r.floorBreaches[m.id]?.length).map(
		(m) => `${m.label} (${r.floorBreaches[m.id]?.join(", ")})`,
	);
	lines.push(
		`**Safety floors breached:** ${breaches.join("; ") || "none"}.`,
		"",
	);
	if (r.arms.includes("portia")) {
		lines.push(
			`**Portia leads on:** ${r.portiaLeads.map((id) => MEASURES.find((m) => m.id === id)?.label).join(", ") || "nothing"}.`,
			"",
			`**Portia trails on:** ${r.portiaTrails.map((id) => MEASURES.find((m) => m.id === id)?.label).join(", ") || "nothing"}.`,
			"",
		);
	}
	for (const epic of r.epics) {
		lines.push(
			`## ${epic}`,
			"",
			`| Measure | ${r.arms.join(" | ")} |`,
			`| --- | ${r.arms.map(() => "---").join(" | ")} |`,
		);
		for (const m of MEASURES)
			lines.push(
				`| ${heading(m)} | ${r.arms.map((a) => fmt(r.byEpic[m.id]?.[a]?.[epic], m.pct)).join(" | ")} |`,
			);
		lines.push("");
	}
	return lines.join("\n");
}
