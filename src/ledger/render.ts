import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { percent, type RunMetrics } from "../core/metrics";
import { deriveStates, type ScheduleOpts } from "../core/state";
import type {
	ChildState,
	Lane,
	ParentPlan,
	Ripple,
	RunRow,
} from "../core/types";
import { designDir } from "../design/store";
import { span } from "../view/model/format";

/** A pipe in a cell would end it: GitHub reads `\|` as a literal pipe. */
const cellText = (s: string) => s.replace(/\|/g, "\\|");

export const START = "<!-- epic-ledger:start -->";
export const END = "<!-- epic-ledger:end -->";
/** Markers written before the rename; still found, then replaced by the current ones. */
const LEGACY = {
	start: "<!-- portia:ledger:start -->",
	end: "<!-- portia:ledger:end -->",
};

export interface LedgerChild {
	key: string;
	summary: string;
	wave: number;
	state: ChildState;
	pr?: number;
	requirements: { id: string; ok: boolean; evidence?: string }[];
	touchesMatched?: boolean;
	/** The files outside its touches that a landed child had accepted, by kind. */
	ripples: Ripple[];
	design?: string;
	model?: string;
	lane?: Lane;
	/** The last child review's verdict; absent when no review ran. */
	review?: { status: string; findings: number };
}

function verdictOf(dir: string, key: string): string {
	const file = join(designDir(dir, key), "verdict.json");
	if (!existsSync(file)) return "not run";
	return JSON.parse(readFileSync(file, "utf8")).verdict as string;
}

export function ledgerChildren(
	plan: ParentPlan,
	rows: RunRow[],
	dir: string,
	lanes?: Map<string, Lane>,
	opts: ScheduleOpts = {},
): LedgerChild[] {
	const states = deriveStates(plan, rows, opts);
	return plan.children.map((c) => {
		const mine = rows.filter((r) => r.child === c.key);
		const result = mine.filter((r) => r.stage === "result").at(-1);
		const landed = mine.filter((r) => r.stage === "landed").at(-1);
		const review = mine.filter((r) => r.stage === "review").at(-1);
		const evidence = (result?.data?.evidence ?? {}) as Record<string, string>;
		return {
			key: c.key,
			summary: c.summary,
			wave: c.wave,
			state: states.get(c.key) ?? "pending",
			pr: landed?.data?.pr as number | undefined,
			requirements: c.requirements.map((id) => ({
				id,
				ok: Boolean(evidence[id]),
				evidence: evidence[id],
			})),
			touchesMatched: result?.touchesMatched,
			ripples: landed ? (result?.ripples ?? []) : [],
			design: c.design ? verdictOf(dir, c.key) : undefined,
			model: mine.filter((r) => r.model).at(-1)?.model?.requested,
			lane: lanes?.get(c.key),
			review: review && {
				status: review.status ?? "error",
				findings: Array.isArray(review.data?.findings)
					? review.data.findings.length
					: 0,
			},
		};
	});
}

const designCell = (d?: string) =>
	d === undefined ? "" : d === "UNCERTAIN" ? "**UNCERTAIN: check by eye**" : d;
const reviewCell = (r?: LedgerChild["review"]) =>
	!r
		? ""
		: r.status === "clean"
			? "clean"
			: r.status === "findings"
				? `**${r.findings || "some"} finding${r.findings === 1 ? "" : "s"}**`
				: "**review error**";
const touchesCell = (m?: boolean) =>
	m === undefined ? "" : m ? "matched" : "**outside touches**";

const mins = (m: number) => span(m * 60_000);
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Gate failures by step, most first, each with its waves: "unit ×3 (wave 1 ×2, wave 2)". */
export function gateFailuresText(f: RunMetrics["gateFailures"]): string {
	const steps = new Map<string, RunMetrics["gateFailures"]>();
	for (const x of f) steps.set(x.step, [...(steps.get(x.step) ?? []), x]);
	return [...steps]
		.map(([step, xs]) => ({
			step,
			xs,
			n: xs.reduce((s, x) => s + x.count, 0),
		}))
		.sort((a, b) => b.n - a.n)
		.map(
			({ step, xs, n }) =>
				`${step} ×${n} (${xs.map((x) => `wave ${x.wave}${x.count > 1 ? ` ×${x.count}` : ""}`).join(", ")})`,
		)
		.join(", ");
}

/** The run's figures as label and value, for the ledger. */
export function metricsCells(m: RunMetrics): [string, string][] {
	const d = m.decisions;
	return [
		[
			"First-pass land rate",
			m.landed
				? `${percent(m.firstPass, m.landed)}% (${m.firstPass} of ${m.landed} landed)`
				: "nothing landed yet",
		],
		[
			"Rework",
			`${percent(m.rework.tokens, m.tokens)}% of tokens, ${percent(m.rework.minutes, m.workMinutes)}% of minutes (${m.rework.retries === 1 ? "1 retry" : `${m.rework.retries} retries`}, ${count(m.rework.failedLands, "failed land")})`,
		],
		[
			"Critical path vs work",
			`${mins(m.criticalPathMinutes)} of ${mins(m.workMinutes)} worker time`,
		],
		[
			"Human decisions",
			`${d.signoffs + d.parks} (${count(d.signoffs, "sign-off")}, ${count(d.parks, "park")})${d.scripted ? `, ${d.scripted} scripted` : ""}`,
		],
		["Gate failures", gateFailuresText(m.gateFailures) || "none"],
	];
}

export function renderLedger(
	plan: ParentPlan,
	children: LedgerChild[],
	metrics?: RunMetrics,
): string {
	const laned = children.some((c) => c.lane);
	// The Review column shows only once some child has been reviewed.
	const reviewed = children.some((c) => c.review);
	const rows = children.map(
		(c) =>
			`| ${c.wave} | ${c.key} ${cellText(c.summary)} | ${c.state} | ${c.pr ? `#${c.pr}` : ""} | ${c.requirements.map((r) => `${r.id} ${r.ok ? "✓" : "✗"}`).join(" ")} | ${touchesCell(c.touchesMatched)} | ${designCell(c.design)} |${reviewed ? ` ${reviewCell(c.review)} |` : ""} ${c.model ?? ""} |${laned ? ` ${c.lane ?? ""} |` : ""}`,
	);
	const evidence = children.flatMap((c) =>
		c.requirements
			.filter((r) => r.evidence)
			.map((r) => `- ${c.key} ${r.id}: ${r.evidence?.split("\n")[0]}`),
	);
	const ripples = children.flatMap((c) =>
		c.ripples.map((r) => `- ${c.key} ${r.kind}: ${r.file}`),
	);
	return [
		`## Ledger: ${plan.key}`,
		"",
		`| Wave | Child | State | PR | Requirements | Touches | Design |${reviewed ? " Review |" : ""} Model |${laned ? " Lane |" : ""}`,
		`| --- | --- | --- | --- | --- | --- | --- |${reviewed ? " --- |" : ""} --- |${laned ? " --- |" : ""}`,
		...rows,
		"",
		...(metrics
			? [
					"### Metrics",
					"",
					"| Figure | Value |",
					"| --- | --- |",
					...metricsCells(metrics).map(([k, v]) => `| ${k} | ${cellText(v)} |`),
					"",
				]
			: []),
		"### Evidence",
		"",
		...(evidence.length ? evidence : ["_None yet._"]),
		...(ripples.length
			? [
					"",
					"### Ripples",
					"",
					"Accepted edits outside the plan.",
					"",
					...ripples,
				]
			: []),
		"",
		"_Rendered from the tracker, GitHub and the run log. Edits between the markers are overwritten._",
	].join("\n");
}

/** The marker pair a body uses: the current one, else the one from before the rename. */
export const regionMarks = (
	body: string,
): { start: string; end: string } | undefined =>
	[{ start: START, end: END }, LEGACY].find((m) => body.indexOf(m.start) >= 0);

export function replaceRegion(body: string, ledger: string): string {
	const block = `${START}\n${ledger}\n${END}`;
	const marks = regionMarks(body);
	if (!marks) return `${body.trimEnd()}\n\n${block}`;
	const s = body.indexOf(marks.start);
	const e = body.indexOf(marks.end, s + marks.start.length);
	if (e < 0) {
		// An orphaned start marker: drop only its line so no text is spliced over.
		const rest = body.slice(s + marks.start.length).replace(/^\n/, "");
		return `${(body.slice(0, s) + rest).trimEnd()}\n\n${block}`;
	}
	return body.slice(0, s) + block + body.slice(e + marks.end.length);
}
