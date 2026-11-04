import { minutesSince, NOT_A_PERSON } from "./signoff";
import type { ChildPlan, RunRow } from "./types";

export interface RunMetrics {
	landed: number;
	/** Children that landed on attempt 1 with no land failed for a reason of their own. */
	firstPass: number;
	tokens: number;
	workMinutes: number;
	/** Tokens and minutes on attempts after the first, and on attempts whose land failed and never landed. */
	rework: {
		tokens: number;
		minutes: number;
		retries: number;
		failedLands: number;
	};
	/**
	 * Each wave waits for the one before it to land, so the workers' minutes on the run's
	 * longest path are the slowest child's in each wave, summed. Waiting and landing are left out.
	 */
	criticalPathMinutes: number;
	decisions: {
		/** Sign-offs (plan approval, spec sign-off) and parks, which each need an answer. */
		signoffs: number;
		parks: number;
		/** Of those, how many the scripted person of PORTIA_EVAL_ANSWERS answered. */
		scripted: number;
	};
	/** Failed gate runs by the first step that failed, then by wave. */
	gateFailures: { step: string; wave: number; count: number }[];
}

const isAttempt = (r: RunRow, a: number) => r.attempt === a;

/**
 * The run's rework and human figures from its run log, for the ledger and `portia view`.
 * An attempt's minutes run from its dispatch to its result (or, without one, its landing);
 * a child still working counts nothing for its open attempt.
 */
export function runMetrics(
	children: Pick<ChildPlan, "key" | "wave">[],
	rows: RunRow[],
): RunMetrics {
	const m: RunMetrics = {
		landed: 0,
		firstPass: 0,
		tokens: 0,
		workMinutes: 0,
		rework: { tokens: 0, minutes: 0, retries: 0, failedLands: 0 },
		criticalPathMinutes: 0,
		decisions: { signoffs: 0, parks: 0, scripted: 0 },
		gateFailures: [],
	};
	const waveOf = new Map(children.map((c) => [c.key, c.wave]));
	const slowest = new Map<number, number>();
	for (const c of children) {
		const mine = rows.filter((r) => r.child === c.key);
		const landed = mine.find((r) => r.stage === "landed");
		const failedLands = mine.filter(
			(r) =>
				r.stage === "land" && r.status === "failed" && r.data?.infra !== true,
		);
		m.rework.failedLands += failedLands.length;
		const dispatches = mine.filter((r) => r.stage === "dispatched");
		m.rework.retries += Math.max(0, dispatches.length - 1);
		if (landed) {
			m.landed++;
			if (landed.attempt === 1 && !failedLands.length) m.firstPass++;
		}
		let childMinutes = 0;
		for (const d of dispatches) {
			const result = mine.find(
				(r) => r.stage === "result" && isAttempt(r, d.attempt),
			);
			const end =
				result?.at ?? (landed && isAttempt(landed, d.attempt) ? landed.at : "");
			const minutes = end ? minutesSince(d.at, end) : 0;
			const tokens = result?.tokens ?? 0;
			childMinutes += minutes;
			m.tokens += tokens;
			const wasted =
				d.attempt > 1 ||
				(failedLands.some((r) => isAttempt(r, d.attempt)) &&
					!(landed && isAttempt(landed, d.attempt)));
			if (wasted) {
				m.rework.minutes += minutes;
				m.rework.tokens += tokens;
			}
		}
		m.workMinutes += childMinutes;
		slowest.set(c.wave, Math.max(slowest.get(c.wave) ?? 0, childMinutes));
	}
	m.criticalPathMinutes = [...slowest.values()].reduce((s, v) => s + v, 0);

	const failures = new Map<
		string,
		{ step: string; wave: number; count: number }
	>();
	for (const r of rows) {
		if (r.stage === "approval" || r.stage === "signoff") {
			// Drive's own sign-off of clean specs, and the reviewer's no, are no one's decision.
			if (NOT_A_PERSON.has(r.data?.by)) continue;
			m.decisions.signoffs++;
			if (r.data?.by === "eval") m.decisions.scripted++;
		} else if (
			r.status === "parked" &&
			(r.stage === "result" || r.stage === "land")
		)
			m.decisions.parks++;
		// A park decided after a failure; a parked result or land already counts its own.
		else if (
			r.stage === "decision" &&
			r.status === "park" &&
			r.data?.kind === "failure"
		)
			m.decisions.parks++;
		else if (
			r.stage === "decision" &&
			r.data?.by === "eval" &&
			r.data?.kind === "parked"
		)
			m.decisions.scripted++;
		else if (r.stage === "gate" && r.status === "fail") {
			const wave = waveOf.get(r.child);
			if (wave === undefined) continue;
			const steps = Array.isArray(r.data?.steps)
				? (r.data.steps as { name?: unknown; ok?: unknown }[])
				: [];
			const step = String(
				steps.find((s) => s?.ok === false)?.name ?? "unknown",
			);
			const id = `${step}\u0000${wave}`;
			const f = failures.get(id) ?? { step, wave, count: 0 };
			f.count++;
			failures.set(id, f);
		}
	}
	m.gateFailures = [...failures.values()].sort(
		(a, b) =>
			b.count - a.count || a.wave - b.wave || a.step.localeCompare(b.step),
	);
	return m;
}

/** The share of `part` in `whole` as a whole percentage; 0 of nothing is 0%. */
export const percent = (part: number, whole: number): number =>
	whole ? Math.round((part / whole) * 100) : 0;
