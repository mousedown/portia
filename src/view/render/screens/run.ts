import { percent } from "../../../core/metrics";
import { age, span, tokens } from "../../model/format";
import type { RunView } from "../../model/types";
import { runChildren } from "../../select";
import {
	type Ctx,
	clockNow,
	crumb,
	hints,
	indent,
	linked,
	pageHeader,
	rule,
	runCrumbs,
	runGlyphSpan,
	startedAgo,
	webOf,
} from "../common";
import { compose } from "../frame";
import { GRID_LABEL, machineTail } from "../machine";
import { compactMap, runMap } from "../map";
import { footer } from "../overlays";
import type { Line, Span } from "../text";
import { lineWidth, sp } from "../text";
import { childrenBody, childrenDock, selectedChild } from "./children";
import { gatesBody } from "./gates";

const GROUP_WORD = {
	waiting: "waiting on you",
	session: "in session",
	judgement: "needs you",
	rest: "at rest",
	delivered: "delivered",
};

/** "plan 2m old", "from the ledger" or "from the runlog": where the plan came from. */
export function sourceNote(ctx: Ctx, r: RunView): string {
	if (r.source === "ledger") return "from the ledger";
	if (r.source === "runlog") return "from the runlog";
	if (
		r.source === "plan" &&
		r.planAt &&
		r.lastAt &&
		Date.parse(r.planAt) < Date.parse(r.lastAt)
	)
		return `plan ${age(ctx.tick.now - Date.parse(r.planAt))} old`;
	return "";
}

/** Rows the children list keeps under the map before the map gives way. */
const MAP_MIN_LIST = 16;
/** The same for the compact map, which costs a row or two and so gives way far later. */
const COMPACT_MIN_LIST = 8;

type Part = { spans: Span[]; drop: number };

/**
 * One row of the page's labelled grid: the label in `GRID_LABEL` cells, then the parts
 * with a dot between them. When the row is full the parts go by their `drop`, lowest
 * first; a part with drop 0 always stays.
 */
function gridRow(ctx: Ctx, label: string, parts: Part[]): Line {
	const sep = " · ";
	const lead = indent(ctx) + GRID_LABEL;
	const width = () =>
		lead +
		parts.reduce((w, p, i) => w + (i ? sep.length : 0) + lineWidth(p.spans), 0);
	for (let level = 1; parts.some((p) => p.drop >= level); level++)
		while (width() > ctx.W && parts.some((p) => p.drop === level))
			parts.splice(
				parts.findIndex((p) => p.drop === level),
				1,
			);
	const out: Span[] = [
		sp(indent(ctx)),
		{ text: label.padEnd(GRID_LABEL), role: "dim" },
	];
	parts.forEach((p, i) => {
		if (i) out.push({ text: sep, role: "dim" });
		out.push(...p.spans);
	});
	return out;
}

/** `epic  #412 · epic/ACME-500 · started 2d ago`: where the run lives, and since when. */
function epicRow(ctx: Ctx, r: RunView): Line {
	const started = startedAgo(ctx, r);
	const note = sourceNote(ctx, r);
	const parts: Part[] = [];
	const web = webOf(ctx, r.key);
	if (r.epicPr)
		parts.push({
			spans: linked(
				[{ text: `#${r.epicPr}`, role: "accent" }],
				web.pr(r.epicPr),
			),
			drop: 0,
		});
	if (r.branch)
		parts.push({
			spans: linked([{ text: r.branch, role: "ink2" }], web.branch(r.branch)),
			drop: 2,
		});
	parts.push({
		spans: [
			{
				text: started
					? ctx.narrow
						? started
						: `started ${started} ago`
					: "not started",
				role: "ink2",
			},
		],
		drop: 1,
	});
	if (note) parts.push({ spans: [{ text: note, role: "dim" }], drop: 3 });
	return gridRow(ctx, "epic", parts);
}

/** `progress  1 of 7 landed · 1.29M tokens`. */
function progressRow(ctx: Ctx, r: RunView): Line {
	const landed = r.children.filter((c) => c.state === "landed").length;
	const n = r.children.length;
	return gridRow(ctx, "progress", [
		{
			spans: [
				{
					text: ctx.narrow ? `${landed}/${n}` : `${landed} of ${n}`,
					role: "ink",
				},
				{ text: " landed", role: "ink2" },
			],
			drop: 0,
		},
		{ spans: [{ text: `${tokens(r.tokens)} tokens`, role: "ink2" }], drop: 1 },
	]);
}

/**
 * `rework  first pass 1/1 · 0% tokens 0% time · critical path 21m of 21m · 1 decision`:
 * the run's figures, the last going first when the row is full. Nothing until a worker
 * has finished something.
 */
function reworkRow(ctx: Ctx, r: RunView): Line | undefined {
	const m = r.metrics;
	if (!m.landed && !m.workMinutes) return undefined;
	const n = ctx.narrow;
	const mins = (x: number) => span(x * 60_000);
	const d = m.decisions;
	const decisions = d.signoffs + d.parks;
	const failures = m.gateFailures.reduce((s, f) => s + f.count, 0);
	const texts = [
		n
			? `${percent(m.rework.tokens, m.tokens)}%`
			: `${percent(m.rework.tokens, m.tokens)}% tokens ${percent(m.rework.minutes, m.workMinutes)}% time`,
		m.landed
			? `${n ? "1st pass" : "first pass"} ${m.firstPass}/${m.landed}`
			: "",
		`${n ? "path" : "critical path"} ${mins(m.criticalPathMinutes)} of ${mins(m.workMinutes)}`,
		`${decisions} decision${decisions === 1 ? "" : "s"}${d.scripted ? ` (${d.scripted} scripted)` : ""}`,
		failures
			? `${failures} gate failure${failures === 1 ? "" : "s"}${n ? "" : `, most ${m.gateFailures[0]?.step}`}`
			: "",
	].filter(Boolean);
	return gridRow(
		ctx,
		"rework",
		texts.map((text, i) => ({
			spans: [{ text, role: "dim" as const }],
			drop: i ? texts.length - i : 0,
		})),
	);
}

/** `machine  mem 64% · cpu 8% · disk 485G free`: what the machine has left for the run. */
function machineRow(ctx: Ctx): Line | undefined {
	const tail = machineTail(ctx);
	if (!tail.length) return undefined;
	return gridRow(
		ctx,
		"machine",
		tail.map((spans, i) => ({ spans, drop: i ? tail.length - i : 0 })),
	);
}

/** The Run page's keys: `o` only when the selected child or the run has a PR, `d` only once there is an epic diff. */
function runHints(ctx: Ctx, r: RunView, pr: boolean): string[] {
	return [
		"↑↓ move",
		"→ open",
		ctx.state.matrix ? "g children" : "g gate matrix",
		pr ? "o PR" : "",
		r.hasEpicDiff ? "d epic diff" : "",
		"/ filter",
		"← back",
		"? help",
	];
}

/** `o` opens the selected child's PR, or the epic PR when no child is selected. */
function hasPr(ctx: Ctx, r: RunView): boolean {
	const c = selectedChild(ctx, r);
	return c ? c.pr !== undefined : r.epicPr !== undefined;
}

export function runScreen(ctx: Ctx, r: RunView): Line[] {
	const matrix = ctx.state.matrix;
	const glyph = runGlyphSpan(ctx, r);
	const right: Line = ctx.narrow
		? [glyph, { text: ` ${clockNow(ctx)}`, role: "dim" }]
		: [
				glyph,
				{ text: ` ${GROUP_WORD[r.group]}`, role: "ink2" },
				{ text: ` · ${clockNow(ctx)}`, role: "dim" },
			];
	// No summary, no span: a dash in a breadcrumb reads as a glitch, not as "none".
	const filtered = runChildren(r, ctx.state);
	const top: Line[] = [
		...pageHeader(
			ctx,
			runCrumbs(ctx, [
				...linked(crumb(r.key).slice(0, 1), webOf(ctx, r.key).issue(r.key)),
				...crumb(r.key, r.summary).slice(1),
			]),
			right,
		),
		rule(ctx),
		epicRow(ctx, r),
		progressRow(ctx, r),
	];
	if (r.planUrl)
		top.push(
			gridRow(ctx, "plan", [
				{
					spans: linked([{ text: r.planUrl, role: "accent" }], r.planUrl),
					drop: 0,
				},
			]),
		);
	const figs = ctx.size.rows >= 28 ? reworkRow(ctx, r) : undefined;
	if (figs) top.push(figs);
	const mach = ctx.size.rows >= 32 ? machineRow(ctx) : undefined;
	if (mach) top.push(mach);
	// The run's shape over the list: the full map while the list keeps its rows under it,
	// else the compact one, so a run with waves always shows them.
	if (!matrix) {
		const room = (m: Line[]) => ctx.size.rows - top.length - m.length - 1;
		const w = ctx.W - indent(ctx);
		const full = runMap(ctx, r, w);
		const compact = compactMap(ctx, r, w);
		const map =
			full.length && room(full) >= MAP_MIN_LIST
				? full
				: compact.length && room(compact) >= COMPACT_MIN_LIST
					? compact
					: [];
		if (map.length)
			top.push([], ...map.map((l): Line => [sp(indent(ctx) - 1), ...l]));
	}
	if (ctx.state.filter?.text)
		top.push([
			sp(indent(ctx)),
			{
				text: `${filtered.length} of ${r.children.length} children match`,
				role: "accent",
			},
		]);
	top.push([]);
	const body = matrix ? gatesBody(ctx, r) : childrenBody(ctx, r);
	return compose(ctx, {
		top,
		body: body.lines,
		sel: body.sel,
		items: body.items,
		scrollKey: `run:${r.key}:${matrix ? "gates" : "children"}`,
		dock: ctx.size.rows >= 20 ? childrenDock(ctx, r) : [],
		footer: footer(ctx, hints(ctx, runHints(ctx, r, hasPr(ctx, r))), {
			m: filtered.length,
			n: r.children.length,
		}),
	});
}
