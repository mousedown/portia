import {
	CATCH_POINTS,
	CAUSES,
	type CatchPoint,
	type CauseTotal,
	PARK_KINDS,
	type ParkKind,
} from "../core/causes";
import { percent, type RunMetrics, runMetrics } from "../core/metrics";
import type { RippleGlobs } from "../core/ripple";
import type { Run } from "../core/runs";
import {
	type Classified,
	DEFAULT_RIPPLE_GLOBS,
	firstFailingStep,
	wastedAttempts,
} from "./classify";

export interface EpicGateFailure {
	step: string;
	/** Children landed on the integration branch when it failed: the changes it covers. */
	children: number;
}

/** A wave gate that failed: the wave it followed, and the same counts as an epic gate's. */
export interface WaveGateFailure extends EpicGateFailure {
	wave: number;
}

/** Where a gate failure in the detail happened: its run and its time. */
interface Located {
	run: string;
	at: string;
}

export interface Totals {
	runs: number;
	children: number;
	landed: number;
	firstPass: number;
	/** First-pass landings as a share of children, in percent. */
	firstPassRate: number;
	tokens: number;
	workMinutes: number;
	rework: RunMetrics["rework"];
	/** Rework as a share of all tokens and all minutes, in percent. */
	reworkShare: { tokens: number; minutes: number };
	epicGateFailures: number;
	waveGateFailures: number;
	decisions: RunMetrics["decisions"];
	decisionsPerChild: number;
	gateFailures: { step: string; count: number }[];
	caught: Record<CatchPoint, number>;
	epicGate: EpicGateFailure[];
	waveGate: WaveGateFailure[];
}

export interface Detail {
	runs: string[];
	attempts: (Classified & { answer?: string })[];
	epicGate: (EpicGateFailure & Located)[];
	waveGate: (WaveGateFailure & Located)[];
}

/** The parked cause split by what the park was on. */
export interface ParkTotal {
	on: ParkKind;
	count: number;
	tokens: number;
}

export interface Insights {
	totals: Totals;
	causes: CauseTotal[];
	parks: ParkTotal[];
	detail?: Detail;
}

function gateFailures(run: Run): {
	epic: (EpicGateFailure & Located)[];
	wave: (WaveGateFailure & Located)[];
} {
	const epic: (EpicGateFailure & Located)[] = [];
	const wave: (WaveGateFailure & Located)[] = [];
	const landed = new Set<string>();
	for (const r of run.rows) {
		if (r.stage === "landed") landed.add(r.child);
		else if (r.status !== "fail") continue;
		const failure = {
			step: firstFailingStep(r),
			children: landed.size,
			run: run.key,
			at: r.at,
		};
		if (r.stage === "epic") epic.push(failure);
		else if (r.stage === "wave-gate")
			wave.push({ ...failure, wave: Number(r.data?.wave) });
	}
	return { epic, wave };
}

const causeId = (w: Classified) =>
	`${w.cause.kind}\u0000${"step" in w.cause ? w.cause.step : ""}`;

function rankCauses(wasted: Classified[]): CauseTotal[] {
	const by = new Map<string, CauseTotal & { seen: Set<string> }>();
	for (const w of wasted) {
		const id = causeId(w);
		const t = by.get(id) ?? {
			kind: w.cause.kind,
			...("step" in w.cause ? { step: w.cause.step } : {}),
			count: 0,
			tokens: 0,
			minutes: 0,
			runs: 0,
			seen: new Set<string>(),
		};
		t.count++;
		t.tokens += w.tokens;
		t.minutes = Math.round((t.minutes + w.minutes) * 10) / 10;
		t.seen.add(w.run);
		by.set(id, t);
	}
	return [...by.values()]
		.map(({ seen, ...t }) => ({ ...t, runs: seen.size }))
		.sort(
			(a, b) =>
				b.tokens - a.tokens ||
				b.minutes - a.minutes ||
				b.count - a.count ||
				CAUSES.indexOf(a.kind) - CAUSES.indexOf(b.kind) ||
				(a.step ?? "").localeCompare(b.step ?? ""),
		);
}

function parkTotals(wasted: Classified[]): ParkTotal[] {
	return PARK_KINDS.map((on) => {
		const mine = wasted.filter(
			(w) => w.cause.kind === "parked" && w.cause.on === on,
		);
		return {
			on,
			count: mine.length,
			tokens: mine.reduce((s, w) => s + w.tokens, 0),
		};
	});
}

/** Totals equal to `runMetrics` summed over `runs`, and every wasted attempt ranked by cause. */
export function insights(
	runs: Run[],
	detailed = false,
	globs: RippleGlobs = DEFAULT_RIPPLE_GLOBS,
): Insights {
	const metrics = runs.map((r) => runMetrics(r.plan.children, r.rows));
	const sum = (f: (m: RunMetrics) => number) =>
		metrics.reduce((s, m) => s + f(m), 0);
	const wasted = runs.flatMap((r) => wastedAttempts(r, globs));
	const gates = runs.map(gateFailures);
	const epic = gates.flatMap((g) => g.epic);
	const wave = gates.flatMap((g) => g.wave);
	const children = runs.reduce((s, r) => s + r.plan.children.length, 0);
	const tokens = sum((m) => m.tokens);
	const workMinutes = Math.round(sum((m) => m.workMinutes) * 10) / 10;
	const rework = {
		tokens: sum((m) => m.rework.tokens),
		minutes: Math.round(sum((m) => m.rework.minutes) * 10) / 10,
		retries: sum((m) => m.rework.retries),
		failedLands: sum((m) => m.rework.failedLands),
	};
	const decisions = {
		signoffs: sum((m) => m.decisions.signoffs),
		parks: sum((m) => m.decisions.parks),
		scripted: sum((m) => m.decisions.scripted),
	};
	const steps = new Map<string, number>();
	for (const m of metrics)
		for (const f of m.gateFailures)
			steps.set(f.step, (steps.get(f.step) ?? 0) + f.count);
	const caught = Object.fromEntries(CATCH_POINTS.map((p) => [p, 0])) as Record<
		CatchPoint,
		number
	>;
	const failures = new Map<string, CatchPoint>();
	for (const w of wasted)
		failures.set(`${w.run}\u0000${w.child}\u0000${w.source}`, w.caught);
	for (const p of failures.values()) caught[p]++;
	caught["wave-gate"] += wave.length;
	caught["epic-gate"] += epic.length;
	const totals: Totals = {
		runs: runs.length,
		children,
		landed: sum((m) => m.landed),
		firstPass: sum((m) => m.firstPass),
		firstPassRate: percent(
			sum((m) => m.firstPass),
			children,
		),
		tokens,
		workMinutes,
		rework,
		reworkShare: {
			tokens: percent(rework.tokens, tokens),
			minutes: percent(rework.minutes, workMinutes),
		},
		epicGateFailures: epic.length,
		waveGateFailures: wave.length,
		decisions,
		decisionsPerChild: children
			? Math.round(((decisions.signoffs + decisions.parks) / children) * 100) /
				100
			: 0,
		gateFailures: [...steps]
			.map(([step, count]) => ({ step, count }))
			.sort((a, b) => b.count - a.count || a.step.localeCompare(b.step)),
		caught,
		epicGate: epic.map(({ step, children }) => ({ step, children })),
		waveGate: wave.map(({ wave, step, children }) => ({
			wave,
			step,
			children,
		})),
	};
	return {
		totals,
		causes: rankCauses(wasted),
		parks: parkTotals(wasted),
		...(detailed
			? {
					detail: {
						runs: runs.map((r) => r.key),
						attempts: wasted,
						epicGate: epic,
						waveGate: wave,
					},
				}
			: {}),
	};
}

const LABEL: Record<CauseTotal["kind"], string> = {
	"child-gate": "gate failed on the child's head",
	"exit-gate-rebased": "exit gate failed on the rebased head (R6)",
	"rebase-conflict": "rebase conflict onto the integration branch",
	ci: "CI failed or timed out on the child PR",
	"changed-after-gate": "changed after its gate",
	parked: "parked",
	infra: "infra (not the child's fault; not rework)",
	unknown: "unknown",
};

const n = (v: number) => v.toLocaleString("en-GB");

/** The report as text, for a person at a terminal. */
export function renderInsights(r: Insights): string {
	const t = r.totals;
	const lines = [
		`Runs ${t.runs} · children ${t.children} · landed ${t.landed} · first pass ${t.firstPass} (${t.firstPassRate}%)`,
		`Tokens ${n(t.tokens)} · rework ${n(t.rework.tokens)} (${t.reworkShare.tokens}%)`,
		`Minutes ${t.workMinutes} · rework ${t.rework.minutes} (${t.reworkShare.minutes}%)`,
		`Retries ${t.rework.retries} · failed lands ${t.rework.failedLands} · wave-gate failures ${t.waveGateFailures} · epic-gate failures ${t.epicGateFailures} · decisions per child ${t.decisionsPerChild}`,
		"",
		"Causes, by tokens lost",
	];
	if (!r.causes.length) lines.push("  none");
	for (const c of r.causes)
		lines.push(
			`  ${LABEL[c.kind]}${c.step ? `: ${c.step}` : ""} — ${c.count} attempt(s), ${n(c.tokens)} tokens, ${c.minutes} min, ${c.runs} run(s)`,
		);
	const counted = r.causes.filter((c) => c.kind !== "infra");
	lines.push(
		`  rework counted: ${n(counted.reduce((s, c) => s + c.tokens, 0))} tokens`,
	);
	const parks = r.parks.filter((p) => p.count > 0);
	if (parks.length) {
		lines.push("", "Parked, by what it was on");
		for (const p of parks)
			lines.push(`  ${p.on} — ${p.count} attempt(s), ${n(p.tokens)} tokens`);
	}
	if (t.waveGate.length) {
		lines.push("", "Wave gate");
		for (const w of t.waveGate)
			lines.push(
				`  wave ${w.wave} failed at ${w.step}, covering ${w.children} child(ren)`,
			);
	}
	lines.push("", "Epic gate");
	if (!t.epicGate.length) lines.push("  no failures");
	for (const e of t.epicGate)
		lines.push(`  failed at ${e.step}, covering ${e.children} child(ren)`);
	lines.push(
		"",
		"Where caught",
		...Object.entries(t.caught).map(([p, v]) => `  ${p}: ${v}`),
	);
	if (r.detail) {
		lines.push("", "Wasted attempts");
		for (const a of r.detail.attempts) {
			const c = a.cause;
			const what =
				c.kind === "parked"
					? `parked on ${c.on}, ${c.resolution ?? "unresolved"}${a.answer ? `: ${a.answer}` : ""}`
					: c.kind === "unknown"
						? `unknown (rows ${c.rows.join(", ")})`
						: `${c.kind}${"step" in c ? `: ${c.step}` : ""}${"outcome" in c ? ` (${c.outcome})` : ""}`;
			lines.push(
				`  ${a.run} ${a.child} attempt ${a.attempt}: ${what} — ${n(a.tokens)} tokens, ${a.minutes} min`,
			);
		}
		for (const w of r.detail.waveGate)
			lines.push(
				`  ${w.run} wave ${w.wave} gate failed at ${w.step}, ${w.at} (${w.children} child(ren))`,
			);
		for (const e of r.detail.epicGate)
			lines.push(
				`  ${e.run} epic gate failed at ${e.step}, ${e.at} (${e.children} child(ren))`,
			);
	}
	return lines.join("\n");
}
