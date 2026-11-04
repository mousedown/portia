import type { ChildPlan, ParentPlan, ReqId, RunRow } from "../core/types";
import type { SpecGuard } from "../gate/specs";

export interface OwnedScenario {
	id: ReqId;
	path: string;
}

/** The spec path the spine wrote for each scenario. */
export const spineSpecs = (plan: ParentPlan): Record<ReqId, string> =>
	Object.assign(
		{},
		...plan.children.filter((x) => x.wave === 0).map((x) => x.acceptance),
	);

/**
 * The scenarios a child implements, each with the spec path the spine wrote for it. The
 * spine owns one it lists only when no later child lists it too: it lands first, so it
 * cannot complete a shared one. Every other spec it writes is meant to fail.
 */
export function ownedScenarios(
	plan: ParentPlan,
	c: ChildPlan,
): OwnedScenario[] {
	const specs = spineSpecs(plan);
	const later = (id: ReqId) =>
		plan.children.some((x) => x.wave !== 0 && x.requirements.includes(id));
	return plan.scenarios.flatMap((s) => {
		const path = specs[s.id];
		return c.requirements.includes(s.id) &&
			path &&
			!(c.wave === 0 && later(s.id))
			? [{ id: s.id, path }]
			: [];
	});
}

/**
 * The owned scenarios a child's gate runs now. A scenario several children list can
 * pass only once all of them are in, so it runs at a child's gate only when every
 * other child listing it has a `landed` row: the child that completes it runs it (the
 * land re-gate, under land.lock, is authoritative). `waiting` names the unlanded others.
 */
export function readyScenarios(
	plan: ParentPlan,
	c: ChildPlan,
	rows: RunRow[],
): { ready: OwnedScenario[]; waiting: string[] } {
	const landed = new Set(
		rows.filter((r) => r.stage === "landed").map((r) => r.child),
	);
	const waiting = new Set<string>();
	const ready = ownedScenarios(plan, c).filter((o) => {
		const pending = plan.children.filter(
			(x) =>
				x.key !== c.key &&
				x.wave !== 0 &&
				x.requirements.includes(o.id) &&
				!landed.has(x.key),
		);
		for (const x of pending) waiting.add(x.key);
		return pending.length === 0;
	});
	return { ready, waiting: [...waiting] };
}

/**
 * The gate's view of a child's scenarios, read from the run log in `dir` now. Its guard
 * owns every scenario the child lists, ready or not. The spine has none: it writes the specs,
 * and each one for a scenario it does not own is `failing`, to fail on an assertion now.
 */
export function ownedForGate(
	plan: ParentPlan,
	c: ChildPlan | undefined,
	rows: RunRow[],
): {
	owned: OwnedScenario[];
	waitingOn: string[];
	guard?: SpecGuard;
	failing?: OwnedScenario[];
} {
	if (!c) return { owned: [], waitingOn: [] };
	const { ready, waiting } = readyScenarios(plan, c, rows);
	if (c.wave === 0) {
		const mine = new Set(ownedScenarios(plan, c).map((o) => o.id));
		const failing = plan.scenarios.flatMap((s) => {
			const path = c.acceptance[s.id];
			return path && !mine.has(s.id) ? [{ id: s.id, path }] : [];
		});
		return {
			owned: ready,
			waitingOn: waiting,
			...(failing.length ? { failing } : {}),
		};
	}
	return {
		owned: ready,
		waitingOn: waiting,
		guard: { specs: spineSpecs(plan), owns: c.requirements },
	};
}

/**
 * The scenarios this run's landed children have made pass, each with its spec path, the
 * spine's own included. One that several children list counts once all of them have
 * landed: it ran at the land of the last. So none is a child's own until it lands; its
 * `{owned}` step runs those.
 */
export function landedScenarios(
	plan: ParentPlan,
	rows: RunRow[],
): OwnedScenario[] {
	const landed = new Set(
		rows.filter((r) => r.stage === "landed").map((r) => r.child),
	);
	const specs = spineSpecs(plan);
	return plan.scenarios.flatMap(({ id }) => {
		const path = specs[id];
		const listing = plan.children.filter((x) => x.requirements.includes(id));
		return path && listing.length && listing.every((x) => landed.has(x.key))
			? [{ id, path }]
			: [];
	});
}
