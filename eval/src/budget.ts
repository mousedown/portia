import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { LoadedSuite } from "./suite";
import type { RunResult } from "./types";

/**
 * The eval runs on one Claude subscription (#16's budget rules), so every paid run is
 * recorded in a local ledger, and a run that would take the week past the ceiling is
 * refused before it starts. Weeks are calendar weeks, Monday 00:00 UTC.
 */
export const DEFAULT_WEEKLY_TOKENS = 3_000_000;

export interface LedgerEntry {
	/** When the run finished. */
	at: string;
	suite: string;
	arm: string;
	epic: string;
	n: number;
	tokens: number;
	/** The loop iteration the run was for, when one was named. */
	iteration?: string;
}

/** results/ledger.jsonl: one line per run, never rewritten. */
export const ledgerFile = (root: string) =>
	join(root, "results", "ledger.jsonl");

export function readLedger(root: string): LedgerEntry[] {
	const f = ledgerFile(root);
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

export function record(root: string, e: LedgerEntry) {
	const f = ledgerFile(root);
	mkdirSync(dirname(f), { recursive: true });
	appendFileSync(f, `${JSON.stringify(e)}\n`);
}

/** EVAL_WEEKLY_TOKENS, else the suite's `budget.weeklyTokens`, else 3M. */
export function weeklyCeiling(
	suite: Pick<LoadedSuite, "budget">,
	env: Record<string, string | undefined> = process.env,
): number {
	const fromEnv = Number(env.EVAL_WEEKLY_TOKENS);
	if (env.EVAL_WEEKLY_TOKENS && fromEnv > 0) return fromEnv;
	return suite.budget?.weeklyTokens ?? DEFAULT_WEEKLY_TOKENS;
}

/** Monday 00:00 UTC of the week `d` is in. */
export function weekStart(d: Date): Date {
	const day = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
	);
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return day;
}

const DAY = 86_400_000;
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function spentInWeek(ledger: LedgerEntry[], now: Date): number {
	const from = weekStart(now).getTime();
	const to = from + 7 * DAY;
	return ledger
		.filter((e) => {
			const t = Date.parse(e.at);
			return t >= from && t < to;
		})
		.reduce((s, e) => s + e.tokens, 0);
}

/**
 * What a run is expected to cost: the mean of that arm's past runs on that epic, else of
 * the arm's runs on any epic. Undefined when the arm has never run.
 */
export function expectedTokens(
	ledger: LedgerEntry[],
	arm: string,
	epic: string,
): number | undefined {
	const mean = (es: LedgerEntry[]) =>
		es.length ? es.reduce((s, e) => s + e.tokens, 0) / es.length : undefined;
	const mine = ledger.filter((e) => e.arm === arm);
	return mean(mine.filter((e) => e.epic === epic)) ?? mean(mine);
}

export interface Allowance {
	ok: boolean;
	spent: number;
	/** Undefined when the arm has no past runs to estimate from. */
	expected?: number;
	ceiling: number;
	/** The first day the run fits: next week's Monday. Undefined when it never fits a week. */
	runsOn?: Date;
}

/**
 * May this run start now? A free arm always may. One with no history may while the week
 * is under the ceiling; the per-run spend cap bounds it.
 */
export function allowance(
	ledger: LedgerEntry[],
	o: { arm: string; epic: string; ceiling: number; now: Date; free?: boolean },
): Allowance {
	const spent = spentInWeek(ledger, o.now);
	const expected = o.free ? 0 : expectedTokens(ledger, o.arm, o.epic);
	const ok =
		!!o.free ||
		(expected === undefined
			? spent < o.ceiling
			: spent + expected <= o.ceiling);
	if (ok) return { ok, spent, expected, ceiling: o.ceiling };
	const runsOn =
		(expected ?? 0) <= o.ceiling
			? new Date(weekStart(o.now).getTime() + 7 * DAY)
			: undefined;
	return { ok, spent, expected, ceiling: o.ceiling, runsOn };
}

const m = (x: number) => `${(x / 1_000_000).toFixed(2)}M`;

export function refusal(a: Allowance, arm: string, epic: string): string {
	const why = `${arm} on ${epic} is expected to cost ${a.expected === undefined ? "an unknown amount" : m(a.expected)}; ${m(a.spent)} of this week's ${m(a.ceiling)} is spent`;
	return a.runsOn
		? `refused: ${why}. It can run on ${isoDate(a.runsOn)}.`
		: `refused: ${why}. It is bigger than a whole week's ceiling, so it never fits: raise the ceiling or shrink the epic.`;
}

/**
 * A result is reusable by (arm, arm version, model, suite version, epic). A competitor's
 * version is the harness's revision of the arm plus the Claude Code it ran on; Portia's is
 * its checkout's commit. A dirty or unknown Portia, or an unknown Claude Code, has no
 * version, so nothing is reused for it.
 */
export interface CacheKey {
	arm: string;
	armVersion: string;
	model: string;
	suite: string;
	epic: string;
}

export function armVersion(
	arm: { name: string; version?: string },
	tools: NonNullable<RunResult["tools"]>,
): string | undefined {
	if (arm.name === "portia")
		return tools.portia?.sha && !tools.portia.dirty
			? tools.portia.sha
			: undefined;
	return tools.claude
		? `${arm.version ?? "1"} · claude ${tools.claude}`
		: undefined;
}

export function keyOf(r: RunResult): CacheKey | undefined {
	const v = r.tools?.armVersion;
	const model = r.tools?.model;
	if (!v || !model) return undefined;
	return { arm: r.arm, armVersion: v, model, suite: r.suite, epic: r.epic };
}

const same = (a: CacheKey, b: CacheKey) =>
	a.arm === b.arm &&
	a.armVersion === b.armVersion &&
	a.model === b.model &&
	a.suite === b.suite &&
	a.epic === b.epic;

/** Results already recorded under this key; a void one never stands in for a repeat. */
export const cachedFor = (results: RunResult[], key: CacheKey) =>
	results.filter((r) => {
		const k = keyOf(r);
		return k && !r.void ? same(k, key) : false;
	});

/**
 * What a new version is checked against: the same arm, model, suite and epic on the most
 * recent other version that has results, void ones aside.
 */
export function baselineFor(results: RunResult[], key: CacheKey): RunResult[] {
	const others = results.filter((r) => {
		const k = keyOf(r);
		return (
			k &&
			!r.void &&
			k.arm === key.arm &&
			k.model === key.model &&
			k.suite === key.suite &&
			k.epic === key.epic &&
			k.armVersion !== key.armVersion
		);
	});
	const latest = others.sort((a, b) =>
		b.finishedAt.localeCompare(a.finishedAt),
	)[0];
	return latest
		? others.filter((r) => r.tools?.armVersion === latest.tools?.armVersion)
		: [];
}

/**
 * Clearly worse is outside everything the baseline has shown: fewer hidden scenarios than
 * its worst run, or a larger rework share of tokens than its worst run. One run against
 * a baseline's range, so a level or noisy result carries on to the next repeat.
 */
export function clearlyWorse(
	r: RunResult,
	baseline: RunResult[],
): string | undefined {
	if (!baseline.length) return undefined;
	const pass = Math.min(...baseline.map((b) => b.scores.correctness.passRate));
	const rework = Math.max(...baseline.map((b) => b.scores.rework.tokenShare));
	const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
	if (r.scores.correctness.passRate < pass)
		return `hidden scenarios passed ${pct(r.scores.correctness.passRate)}, below the baseline's worst ${pct(pass)}`;
	if (r.scores.rework.tokenShare > rework)
		return `rework share of tokens ${pct(r.scores.rework.tokenShare)}, above the baseline's worst ${pct(rework)}`;
	return undefined;
}

/** A run waiting for an off-peak slot: what `eval run` would have been given. */
export interface QueueItem {
	/** The suite file, absolute. */
	suite: string;
	arm: string;
	epic: string;
	repeat: number;
	fresh?: boolean;
	stopIfWorse?: boolean;
	iteration?: string;
	addedAt: string;
}

/** results/queue.json, in the order the runs were added. */
export const queueFile = (root: string) => join(root, "results", "queue.json");

export function readQueue(root: string): QueueItem[] {
	const f = queueFile(root);
	return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
}

export function writeQueue(root: string, q: QueueItem[]) {
	const f = queueFile(root);
	mkdirSync(dirname(f), { recursive: true });
	writeFileSync(f, `${JSON.stringify(q, null, "\t")}\n`);
}

/** Tokens and runs per group, in key order. */
function totals(
	ledger: LedgerEntry[],
	group: (e: LedgerEntry) => string,
): { group: string; tokens: number; runs: number }[] {
	const by = new Map<string, { tokens: number; runs: number }>();
	for (const e of ledger) {
		const g = by.get(group(e)) ?? { tokens: 0, runs: 0 };
		g.tokens += e.tokens;
		g.runs += 1;
		by.set(group(e), g);
	}
	return [...by.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([group, t]) => ({ group, ...t }));
}

export const byWeek = (ledger: LedgerEntry[]) =>
	totals(ledger, (e) => isoDate(weekStart(new Date(e.at))));
export const byIteration = (ledger: LedgerEntry[]) =>
	totals(ledger, (e) => e.iteration ?? "(none named)");

const n = (x: number) => x.toLocaleString("en-GB");

/** The section `eval report` ends with: every paid run's tokens, per week and per iteration. */
export function tokensMarkdown(ledger: LedgerEntry[], ceiling: number): string {
	const lines = [
		"## Tokens spent",
		"",
		`From the local ledger, over every suite. The weekly ceiling is ${n(ceiling)} tokens.`,
		"",
	];
	if (!ledger.length) return [...lines, "No paid runs yet.", ""].join("\n");
	lines.push(
		"| Week of | Tokens | Runs | Share of ceiling |",
		"| --- | --- | --- | --- |",
		...byWeek(ledger).map(
			(w) =>
				`| ${w.group} | ${n(w.tokens)} | ${w.runs} | ${((w.tokens / ceiling) * 100).toFixed(0)}% |`,
		),
		"",
		"| Iteration | Tokens | Runs | Tokens per run |",
		"| --- | --- | --- | --- |",
		...byIteration(ledger).map(
			(i) =>
				`| ${i.group} | ${n(i.tokens)} | ${i.runs} | ${n(Math.round(i.tokens / i.runs))} |`,
		),
		"",
	);
	return lines.join("\n");
}

/** The tokens line for an iteration's changelog entry. */
export function changelogTokens(
	ledger: LedgerEntry[],
	iteration: string,
	ceiling: number,
): string {
	const mine = ledger.filter((e) => e.iteration === iteration);
	const tokens = mine.reduce((s, e) => s + e.tokens, 0);
	const weeks = byWeek(mine).map((w) => w.group);
	const weekly = byWeek(ledger)
		.filter((w) => weeks.includes(w.group))
		.map(
			(w) =>
				`week of ${w.group}: ${n(w.tokens)} (${((w.tokens / ceiling) * 100).toFixed(0)}% of the ceiling)`,
		);
	return `**Tokens:** ${n(tokens)} over ${mine.length} run(s) in iteration ${iteration}${weekly.length ? `; ${weekly.join(", ")}` : ""}.`;
}
