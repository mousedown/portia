import { PortiaProblem } from "../core/exit";
import { mapLimit } from "../core/limit";
import type { ChildPlan, Finding, ParentPlan } from "../core/types";
import {
	BlockError,
	type BlockOptions,
	extractBlock,
	parseChild,
	parseParent,
} from "./block";
import type { Tracker, TrackerIssue } from "./tracker";

/**
 * A run's children are the parent's children that carry a plan block, whatever their status.
 * A planned child with an excluded label is an error. Open, non-excluded children without a
 * block are `unplanned`: reported as a warning, never run. Unplanned children that are done
 * or excluded are ignored silently. A need on a done issue outside the run is `satisfied`.
 * A planned child the tracker shows as done is `closed`: never dispatched (see deriveStates).
 */
export async function loadPlan(
	tracker: Tracker,
	parentKey: string,
	topLevel: string[],
	packageDir: string,
	opts: { excludeLabels?: string[] } & BlockOptions = {},
): Promise<{
	plan: ParentPlan;
	findings: Finding[];
	unplanned: string[];
	/** The parent's children as the tracker returned them, descriptions included. */
	issues: TrackerIssue[];
}> {
	// The parent's blockers are never read (parseParent drops them), and it and its
	// children are independent reads, so they are fetched together. The parent is awaited
	// first, so a missing parent still fails with the parent's own error.
	const parentRead = tracker.issue(parentKey, { blockers: false });
	const childrenRead = tracker.children(parentKey);
	childrenRead.catch(() => {});
	const p = await parentRead;
	const siblings = await childrenRead;
	const parent = parseParent(
		{
			key: p.key,
			summary: p.summary,
			description: p.description,
			blockedBy: [],
		},
		opts,
	);
	const excluded = new Set(
		(opts.excludeLabels ?? []).map((l) => l.toLowerCase()),
	);
	const children: ChildPlan[] = [];
	const findings: Finding[] = [];
	const unplanned: string[] = [];
	for (const c of siblings) {
		const label = c.labels.find((l) => excluded.has(l.toLowerCase()));
		if (extractBlock(c.description) === null) {
			if (!c.done && !label) unplanned.push(c.key);
			continue;
		}
		if (label) {
			findings.push({
				rule: "excluded",
				level: "error",
				child: c.key,
				message: `${c.key}: planned but labelled ${label}`,
			});
			continue;
		}
		try {
			children.push(
				parseChild(
					{
						key: c.key,
						summary: c.summary,
						description: c.description,
						blockedBy: c.blockedBy,
					},
					topLevel,
					packageDir,
					opts,
				),
			);
		} catch (e) {
			if (!(e instanceof BlockError)) throw e;
			findings.push({
				rule: "parse",
				level: "error",
				child: c.key,
				message: e.message,
			});
		}
	}
	if (unplanned.length)
		findings.push({
			rule: "unplanned",
			level: "warn",
			message: `not in this run: ${unplanned.join(", ")}`,
		});
	const satisfied = await doneOutside(tracker, children, siblings);
	for (const c of children)
		for (const n of c.needs)
			if (satisfied.includes(n.key))
				findings.push({
					rule: "graph",
					level: "info",
					child: c.key,
					message: `${c.key} needs ${n.key}: already done`,
				});
	const closed = children
		.filter((c) => siblings.some((s) => s.key === c.key && s.done))
		.map((c) => c.key);
	return {
		plan: { ...parent, children, satisfied, closed },
		findings,
		unplanned,
		issues: siblings,
	};
}

/** Outside needs looked up at once; a small cap keeps a tracker's rate limits happy. */
const OUTSIDE_CONCURRENCY = 6;

/** Needed keys outside the run that the tracker shows as done; a missing issue is not done. */
async function doneOutside(
	tracker: Tracker,
	children: ChildPlan[],
	siblings: TrackerIssue[],
): Promise<string[]> {
	const inRun = new Set(children.map((c) => c.key));
	const known = new Map(siblings.map((s) => [s.key, s]));
	const outside = [
		...new Set(children.flatMap((c) => c.needs.map((n) => n.key))),
	].filter((k) => !inRun.has(k));
	const isDone = await mapLimit(outside, OUTSIDE_CONCURRENCY, async (k) => {
		const issue = known.get(k);
		if (issue) return issue.done;
		try {
			return (await tracker.issue(k, { blockers: false })).done;
		} catch (e) {
			if (!(e instanceof PortiaProblem)) throw e;
			return false;
		}
	});
	return outside.filter((_, i) => isDone[i]);
}
