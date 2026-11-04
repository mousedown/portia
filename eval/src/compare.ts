import { ci95, mean } from "./metrics/time";
import { type Cell, counted, MEASURES, valuesOf } from "./report";
import type { RunResult } from "./types";

/**
 * The same arm on two Portia commits: before and after an improvement, measure by measure.
 * A sha prefix is enough. Results without a recorded Portia sha are left out and counted.
 */
export interface Comparison {
	arm: string;
	before: { sha: string; n: number };
	after: { sha: string; n: number };
	unversioned: number;
	/** This arm's results on either commit that `eval void` left out. */
	voided: number;
	rows: {
		id: string;
		label: string;
		better: "high" | "low";
		before: Cell;
		after: Cell;
		delta: number;
		/** Change as a share of before; undefined when before is 0. */
		pct?: number;
		/** True when the change is in the measure's better direction. */
		improved: boolean;
	}[];
}

const cell = (xs: number[]): Cell => ({
	n: xs.length,
	mean: mean(xs),
	sd: 0,
	ci: ci95(xs),
});

export function compareVersions(
	results: RunResult[],
	arm: string,
	before: string,
	after: string,
): Comparison {
	const all = results.filter((r) => r.arm === arm);
	const mine = counted(all);
	const unversioned = mine.filter((r) => !r.tools?.portia?.sha).length;
	const on = (sha: string) => (r: RunResult) =>
		!!r.tools?.portia?.sha?.startsWith(sha);
	const a = mine.filter(on(before));
	const b = mine.filter(on(after));
	const voided = all.filter(
		(r) => r.void && (on(before)(r) || on(after)(r)),
	).length;
	const rows = MEASURES.map((m) => {
		const xa = valuesOf(m, a);
		const xb = valuesOf(m, b);
		const ca = cell(xa);
		const cb = cell(xb);
		const delta = cb.mean - ca.mean;
		return {
			id: m.id,
			label: m.label,
			better: m.better,
			before: ca,
			after: cb,
			delta,
			pct: ca.mean ? delta / Math.abs(ca.mean) : undefined,
			improved: m.better === "high" ? delta > 0 : delta < 0,
		};
	});
	// The heading names the commit matched, not the prefix asked for.
	const full = (rs: RunResult[], prefix: string) =>
		rs[0]?.tools?.portia?.sha ?? prefix;
	return {
		arm,
		before: { sha: full(a, before), n: a.length },
		after: { sha: full(b, after), n: b.length },
		unversioned,
		voided,
		rows,
	};
}

export function comparisonMarkdown(c: Comparison): string {
	const f = (x: number, pct: boolean) =>
		pct
			? `${(x * 100).toFixed(0)}%`
			: Math.abs(x) >= 100
				? x.toFixed(0)
				: x.toFixed(2);
	const lines = [
		`# ${c.arm}: ${c.before.sha.slice(0, 10)} (n=${c.before.n}) → ${c.after.sha.slice(0, 10)} (n=${c.after.n})`,
		"",
		"| Measure | Before | After | Change | |",
		"| --- | --- | --- | --- | --- |",
		...c.rows.map((r) => {
			const p = !!MEASURES.find((m) => m.id === r.id)?.pct;
			const change = `${r.delta >= 0 ? "+" : ""}${f(r.delta, p)}${r.pct !== undefined && !p ? ` (${r.pct >= 0 ? "+" : ""}${(r.pct * 100).toFixed(0)}%)` : ""}`;
			const mark =
				r.before.n && r.after.n
					? r.delta === 0
						? "same"
						: r.improved
							? "better"
							: "worse"
					: "";
			return `| ${r.label} | ${r.before.n ? f(r.before.mean, p) : "—"} | ${r.after.n ? f(r.after.mean, p) : "—"} | ${change} | ${mark} |`;
		}),
		"",
	];
	if (c.voided)
		lines.push(
			`${c.voided} void result(s) for ${c.arm} on these commits were left out.`,
			"",
		);
	if (c.unversioned)
		lines.push(
			`${c.unversioned} result(s) for ${c.arm} carry no Portia sha and were left out.`,
			"",
		);
	return lines.join("\n");
}
