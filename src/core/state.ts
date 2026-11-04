import { intersect } from "../plan/check";
import type { ChildPlan, ChildState, ParentPlan, RunRow } from "./types";

/**
 * How children wait. By default a wave waits for every earlier wave to land. With
 * `byNeeds`, a child waits only for the spine, its declared needs and any earlier-wave
 * child whose touches overlap its own, so it starts as soon as what it builds on is in.
 * With `waveGate`, waves are strict whatever `byNeeds` says: the gate runs between them.
 */
export interface ScheduleOpts {
	waveGate?: boolean;
	byNeeds?: boolean;
}

/** The profile's scheduling, as deriveStates takes it. */
export const scheduleOf = (p: {
	waveGate?: unknown;
	schedule?: "waves" | "needs";
}): ScheduleOpts => ({
	waveGate: p.waveGate !== undefined,
	...(p.schedule === "needs" && p.waveGate === undefined
		? { byNeeds: true }
		: {}),
});

/** The earlier-wave children `c` waits for: all of them, or with `byNeeds` the spine and those it overlaps. */
export function waitsFor(
	plan: ParentPlan,
	c: ChildPlan,
	opts: ScheduleOpts = {},
): ChildPlan[] {
	const earlier = plan.children.filter((o) => o.wave < c.wave);
	if (!opts.byNeeds || opts.waveGate) return earlier;
	return earlier.filter(
		(o) => o.wave === 0 || intersect(o.touches, c.touches, []) !== null,
	);
}

// A "land" row (a land that parked or failed) decides like a result does.
export const DECIDING = new Set(["dispatched", "result", "land", "landed"]);

export function landedKeys(rows: RunRow[]): Set<string> {
	return new Set(rows.filter((r) => r.stage === "landed").map((r) => r.child));
}

/** Planned children closed in the tracker that never landed in this run. */
export function closedOutsideRun(plan: ParentPlan, rows: RunRow[]): string[] {
	const landed = landedKeys(rows);
	return (plan.closed ?? []).filter((k) => !landed.has(k));
}

export const closedWarning = (key: string) =>
	`${key}: closed outside the run, not landed`;

/** The waves a wave gate follows: every wave with children but the last. */
export function gatedWaves(plan: ParentPlan): number[] {
	const waves = [...new Set(plan.children.map((c) => c.wave))].sort(
		(a, b) => a - b,
	);
	return waves.slice(0, -1);
}

/** Whether a wave gate has passed for `wave`, at any tip. */
export const wavePassed = (rows: RunRow[], wave: number) =>
	rows.some(
		(r) =>
			r.stage === "wave-gate" && r.status === "pass" && r.data?.wave === wave,
	);

/** The children of `wave` neither landed in this run nor closed outside it. */
export function waveOpen(
	plan: ParentPlan,
	rows: RunRow[],
	wave: number,
): string[] {
	const landed = landedKeys(rows);
	const closed = new Set(closedOutsideRun(plan, rows));
	return plan.children
		.filter((c) => c.wave === wave && !landed.has(c.key) && !closed.has(c.key))
		.map((c) => c.key);
}

/** The wave whose gate is due: the first gated wave with no pass, once all of it is done. */
export function waveGateDue(
	plan: ParentPlan,
	rows: RunRow[],
): number | undefined {
	for (const w of gatedWaves(plan)) {
		if (wavePassed(rows, w)) continue;
		return waveOpen(plan, rows, w).length ? undefined : w;
	}
	return undefined;
}

/** With `waveGate`, a wave also waits for the wave gate of every earlier wave to pass. */
export function deriveStates(
	plan: ParentPlan,
	rows: RunRow[],
	opts: ScheduleOpts = {},
): Map<string, ChildState> {
	const landed = landedKeys(rows);
	const closed = new Set(closedOutsideRun(plan, rows));
	const done = (k: string) => landed.has(k) || closed.has(k);
	const met = (k: string) => done(k) || !!plan.satisfied?.includes(k);
	const states = new Map<string, ChildState>();
	for (const c of plan.children) {
		const last = rows
			.filter((r) => r.child === c.key && DECIDING.has(r.stage))
			.at(-1);
		if (landed.has(c.key)) states.set(c.key, "landed");
		// Closed in the tracker outside the run: never (re-)dispatched, whatever its rows say.
		else if (closed.has(c.key)) states.set(c.key, "closed");
		else if (last?.stage === "result" || last?.stage === "land")
			states.set(c.key, (last.status as ChildState | undefined) ?? "failed");
		else if (last?.stage === "dispatched") states.set(c.key, "running");
		else {
			// Spine-first. By waves, every earlier wave must have landed, not only the declared
			// needs; by needs, the spine and any earlier child sharing files with this one.
			const earlier = waitsFor(plan, c, opts);
			const open =
				c.needs.every((n) => met(n.key)) &&
				earlier.every((o) => done(o.key)) &&
				(!opts.waveGate || earlier.every((o) => wavePassed(rows, o.wave)));
			states.set(c.key, open ? "ready" : "pending");
		}
	}
	return states;
}

export function readySet(states: Map<string, ChildState>): string[] {
	return [...states].filter(([, s]) => s === "ready").map(([k]) => k);
}

/** Children with a dispatched or landed row: the run has started them, so they are never re-planned. */
export const startedIn = (rows: RunRow[]) =>
	new Set(
		rows
			.filter((r) => r.stage === "dispatched" || r.stage === "landed")
			.map((r) => r.child),
	);
