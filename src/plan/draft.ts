import { z } from "zod";
import type { Profile } from "../core/config";
import { PortiaProblem } from "../core/exit";
import { closedOutsideRun, startedIn } from "../core/state";
import type { Finding, Lane, RunRow } from "../core/types";
import { parseDesignRef } from "../design/ref";
import {
	BlockError,
	extractBlock,
	PLAN_BLOCK,
	parseChild,
	parseParent,
	withPlanBlock,
} from "./block";
import { check, childLanes } from "./check";
import { loadPlan } from "./load";
import { topLevelOf } from "./repo";
import type { Tracker, TrackerIssue } from "./tracker";

/**
 * The planning step: what the planner reads (`planContext`) and the checked plan it writes
 * back onto the tickets (`validatePlan`, then `writePlan`).
 */

const text = (description: string) =>
	description.replace(PLAN_BLOCK, "").trim();

/** Done wins over excluded: a finished ticket is context, whatever its labels. */
function sortChildren(siblings: TrackerIssue[], excludeLabels: string[]) {
	const ex = new Set(excludeLabels.map((l) => l.toLowerCase()));
	const label = (c: TrackerIssue) =>
		c.labels.find((l) => ex.has(l.toLowerCase()));
	return {
		open: siblings.filter((c) => !c.done && !label(c)),
		done: siblings.filter((c) => c.done),
		excluded: siblings.filter((c) => !c.done && label(c)),
		label,
	};
}

export async function planContext(
	tracker: Tracker,
	parentKey: string,
	topLevel: string[],
	profile: Profile,
	rows: RunRow[] = [],
) {
	const p = await tracker.issue(parentKey);
	const { open, done, excluded } = sortChildren(
		await tracker.children(parentKey),
		profile.excludeLabels,
	);
	const brief = (c: TrackerIssue) => ({
		key: c.key,
		summary: c.summary,
		labels: c.labels,
		done: c.done,
		block: extractBlock(c.description),
	});
	const names = (steps: { name: string }[]) => steps.map((s) => s.name);
	return {
		parent: {
			key: p.key,
			summary: p.summary,
			description: text(p.description),
			block: extractBlock(p.description),
		},
		children: open.map((c) => ({
			key: c.key,
			summary: c.summary,
			labels: c.labels,
			done: c.done,
			description: text(c.description),
			block: extractBlock(c.description),
			blockedBy: c.blockedBy,
		})),
		done: done.map(brief),
		excluded: excluded.map(brief),
		excludeLabels: profile.excludeLabels,
		maxSize: profile.maxSize,
		lanes: profile.lanes !== undefined,
		run: { started: [...startedIn(rows)] },
		repo: { topLevel, packageDir: profile.packageDir },
		gates: {
			task: names(profile.gates.task),
			exit: names(profile.gates.exit),
			epic: names(profile.gates.epic),
		},
	};
}

const PlanFile = z.object({
	parent: z.object({ block: z.string() }),
	children: z.array(
		z.object({
			key: z.string(),
			block: z.string(),
			needs: z.array(z.string()).optional(),
		}),
	),
});

export interface CheckedPlan {
	parent: { key: string; block: string };
	children: { key: string; block: string; needs: string[] }[];
	/** The warnings and notes the full check raised on the would-be plan. */
	findings: Finding[];
	/** Each child's lane, when the profile or a block uses lanes. */
	lanes?: Record<string, Lane>;
}

/** Nothing written to a ticket names the tool. */
const NAMES_TOOL = /portia/i;

const show = (f: Finding) =>
	`${f.level.padEnd(5)}  ${f.rule.padEnd(12)} ${f.message}`;

/**
 * The tracker as it would read after the write: the draft's blocks in place of the
 * tickets' own, and each draft need already linked. Read-only.
 */
function afterWrite(
	tracker: Tracker,
	plan: Omit<CheckedPlan, "findings">,
): Tracker {
	const drafts = new Map(plan.children.map((c) => [c.key, c]));
	const view = (i: TrackerIssue): TrackerIssue => {
		if (i.key === plan.parent.key)
			return {
				...i,
				description: withPlanBlock(i.description, plan.parent.block),
			};
		const d = drafts.get(i.key);
		return d
			? {
					...i,
					description: withPlanBlock(i.description, d.block),
					blockedBy: [...new Set([...i.blockedBy, ...d.needs])],
				}
			: i;
	};
	const readOnly = async () => {
		throw new PortiaProblem("the would-be plan is read-only");
	};
	return {
		keyPattern: tracker.keyPattern,
		issue: async (k) => view(await tracker.issue(k)),
		children: async (k) => (await tracker.children(k)).map(view),
		comment: readOnly,
		transition: readOnly,
		setPlanBlock: readOnly,
		link: readOnly,
	};
}

const fenced = (block: string) => `\`\`\`plan\n${block.trimEnd()}\n\`\`\``;

/**
 * Parses every block and checks every target before anything is written: each child is
 * an open, non-excluded child of the parent, and each need names an existing ticket (a
 * done one counts as satisfied). No block may name the tool. Then the full check runs on
 * the plan as the tracker would hold it after the write, with every ticket already
 * planned. Any error is a PortiaProblem listing all of them; warnings are returned.
 */
export async function validatePlan(
	tracker: Tracker,
	parentKey: string,
	raw: unknown,
	files: string[],
	profile: Profile,
	rows: RunRow[] = [],
): Promise<CheckedPlan> {
	const topLevel = topLevelOf(files);
	const parsed = PlanFile.safeParse(raw);
	if (!parsed.success)
		throw new PortiaProblem(
			`not a plan file: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
		);
	const file = parsed.data;
	const p = await tracker.issue(parentKey);
	const siblings = await tracker.children(parentKey);
	const { label } = sortChildren(siblings, profile.excludeLabels);
	const known = new Map(siblings.map((s) => [s.key, s]));
	const errors: string[] = [];
	const attempt = (f: () => void) => {
		try {
			f();
		} catch (e) {
			if (!(e instanceof BlockError)) throw e;
			errors.push(e.message);
		}
	};
	if (NAMES_TOOL.test(file.parent.block))
		errors.push(`${p.key}: the block names the tool`);
	attempt(() =>
		parseParent(
			{
				key: p.key,
				summary: p.summary,
				description: fenced(file.parent.block),
				blockedBy: [],
			},
			{ questions: profile.askOnce },
		),
	);
	const children: CheckedPlan["children"] = [];
	const started = startedIn(rows);
	const seen = new Set<string>();
	for (const c of file.children) {
		const key = c.key.toUpperCase();
		if (seen.has(key)) {
			errors.push(`${key} appears twice in the plan file`);
			continue;
		}
		seen.add(key);
		if (started.has(key)) {
			errors.push(
				`${key} has started in this run (dispatched or landed): it is never re-planned`,
			);
			continue;
		}
		const issue = known.get(key);
		if (!issue) {
			errors.push(`${key} is not a child of ${p.key}`);
			continue;
		}
		if (issue.done) {
			errors.push(`${key} is done: a done ticket takes no plan block`);
			continue;
		}
		const l = label(issue);
		if (l) {
			errors.push(`${key} is labelled ${l}: it is never planned`);
			continue;
		}
		if (NAMES_TOOL.test(c.block))
			errors.push(`${key}: the block names the tool`);
		attempt(() => {
			const child = parseChild(
				{
					key,
					summary: issue.summary,
					description: fenced(c.block),
					blockedBy: [],
				},
				topLevel,
				profile.packageDir,
				{ questions: profile.askOnce },
			);
			if (child.design !== undefined)
				try {
					parseDesignRef(child.design);
				} catch (e) {
					if (!(e instanceof PortiaProblem)) throw e;
					errors.push(`${key}: ${e.message}`);
				}
			const needs = child.needs.map((n) => n.key);
			const listed = (c.needs ?? needs).map((n) => n.toUpperCase());
			if ([...listed].sort().join() !== [...needs].sort().join())
				errors.push(
					`${key}: needs [${listed.join(", ")}] disagree with the block's needs [${needs.join(", ")}]`,
				);
			children.push({ key, block: c.block, needs });
		});
	}
	for (const c of children)
		for (const n of c.needs) {
			if (n === c.key) errors.push(`${c.key} needs itself`);
			else if (!known.has(n))
				try {
					await tracker.issue(n);
				} catch (e) {
					if (!(e instanceof PortiaProblem)) throw e;
					errors.push(`${c.key} needs ${n}: no such ticket`);
				}
		}
	const refuse = (lines: string[]) =>
		new PortiaProblem(
			`the plan for ${p.key} was not written:\n${lines.map((e) => `  ${e}`).join("\n")}`,
		);
	if (errors.length) throw refuse(errors);
	const draft = { parent: { key: p.key, block: file.parent.block }, children };
	const loaded = await loadPlan(
		afterWrite(tracker, draft),
		p.key,
		topLevel,
		profile.packageDir,
		{ excludeLabels: profile.excludeLabels, questions: profile.askOnce },
	);
	const findings = [
		...loaded.findings,
		...check(
			loaded.plan,
			files,
			closedOutsideRun(loaded.plan, rows),
			profile.maxSize,
			profile,
			new Map(
				[p, ...siblings].map((i) => [i.key, `${i.summary}\n${i.description}`]),
			),
			[...started],
		),
	];
	if (findings.some((f) => f.level === "error"))
		throw refuse(findings.map(show));
	const lanes = childLanes(loaded.plan, files, profile, rows);
	return { ...draft, findings, lanes: lanes && Object.fromEntries(lanes) };
}

/** Tracker writes in flight at once while a plan is written. */
export const PLAN_WRITE_CONCURRENCY = 6;

/**
 * Blocks first (parent and children together), then a Blocks link per need, each phase
 * several writes at a time: every block is on its own issue, and links go through the
 * tracker's link API, so no two writes edit one issue at once. Idempotent, so a write
 * stopped part way by a tracker error is finished by re-running the same file.
 */
export async function writePlan(
	tracker: Tracker,
	plan: CheckedPlan,
	say: (s: string) => void,
	dryRun: boolean,
): Promise<void> {
	for (const f of plan.findings) say(show(f));
	const prefix = dryRun ? "[dry-run] would write" : "wrote";
	type Step = [string, () => Promise<void>];
	const blocks: Step[] = [plan.parent, ...plan.children].map(
		({ key, block }) => [
			`the plan block on ${key}`,
			() => tracker.setPlanBlock(key, block),
		],
	);
	const links: Step[] = plan.children.flatMap((c) =>
		c.needs.map(
			(n): Step => [
				`${c.key} is blocked by ${n}`,
				() => tracker.link(n, c.key),
			],
		),
	);
	const total = blocks.length + links.length;
	let done = 0;
	for (const phase of [blocks, links]) {
		const failed: unknown[] = [];
		const ok = new Array<boolean>(phase.length).fill(false);
		let next = 0;
		const run = async () => {
			for (let i = next++; i < phase.length; i = next++) {
				const [, write] = phase[i] as Step;
				if (dryRun) ok[i] = true;
				else
					try {
						await write();
						ok[i] = true;
					} catch (e) {
						failed.push(e);
					}
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(PLAN_WRITE_CONCURRENCY, phase.length) },
				run,
			),
		);
		phase.forEach(([what], i) => {
			if (!ok[i]) return;
			done++;
			say(`${prefix} ${what}`);
		});
		if (failed.length) {
			const e = failed[0];
			throw new PortiaProblem(
				`the plan for ${plan.parent.key} was partially written (${done} of ${total} blocks/links done): ${e instanceof Error ? e.message : String(e)}; fix the cause and re-run the same file — the write is idempotent`,
			);
		}
	}
}
