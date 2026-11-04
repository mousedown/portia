import { clock, dayLabel, hhmm, ms } from "../../model/format";
import { isEpicChild } from "../../model/run";
import type { Event, HomeView, Phrase } from "../../model/types";
import { activityEvents, selectedId } from "../../select";
import {
	type Ctx,
	flash,
	hints,
	home,
	indent,
	label,
	marked,
	pageHeader,
	quote,
	rule,
	selected,
} from "../common";
import { compose, type Lazy } from "../frame";
import { footer } from "../overlays";
import {
	asHead,
	cell,
	type Line,
	lr,
	rcell,
	type Span,
	sp,
	strWidth,
	truncate,
} from "../text";
import { censusCompact, matchRight } from "./home";

const QUIET_GAP = 20 * 60_000;

/** The child column: the epic's own rows (its gate, its environment) read as "epic". */
export const who = (e: Event) =>
	isEpicChild(e.run, e.child) ? "epic" : e.child;

/**
 * The detail that fits: the full one with its extra when there is room, else the full one,
 * cut. A failing gate too long to show its failed step says `unit ✗ at 3 of 7` instead.
 */
export function detailFor(p: Phrase, w: number): string {
	if (p.extra && strWidth(p.detail + p.extra) <= w) return p.detail + p.extra;
	// A gate never loses its marks to an ellipsis: short labels, then the count form.
	if (p.compact && strWidth(p.detail) > w)
		return strWidth(p.compact) <= w ? p.compact : (p.short ?? p.compact);
	const failedGate =
		p.glyph === "fail" || (p.glyph === "epic" && p.role === "failed");
	return failedGate && p.short && strWidth(p.detail) > w ? p.short : p.detail;
}

/** The glyph, label and detail of one event, in its roles. */
export function eventSpans(
	ctx: Ctx,
	e: Event,
	labelW: number,
	detailW: number,
	short = false,
): Line {
	const p = e.phrase;
	const glyph: Span = flash(ctx, e.id, {
		text: ctx.g.event[p.glyph],
		role: p.role,
	});
	const detail = short ? (p.short ?? p.detail) : detailFor(p, detailW);
	return [
		glyph,
		sp(1),
		...cell(p.label, labelW, p.role === "landed" ? "landed" : "ink", {
			bold: p.role === "landed",
		}),
		sp(1),
		...truncateDetail(detail, detailW),
	];
}

const truncateDetail = (text: string, w: number): Line => {
	const t = truncate(marked(text, "ink2"), w);
	const tw = t.reduce((n, s) => n + strWidth(s.text), 0);
	return tw < w ? [...t, sp(w - tw)] : t;
};

/**
 * What ⏎ unfolds under an Activity row: the rest of a long message, or the evidence a
 * result reported, each requirement with its scenario text when the plan has it.
 */
export function unfolded(h: HomeView, e: Event): string | undefined {
	if (e.phrase.fold) return e.phrase.fold;
	const ev = e.row.stage === "result" ? e.row.data?.evidence : undefined;
	if (!ev || typeof ev !== "object") return undefined;
	const run = h.runs.find((r) => r.key === e.run);
	const text = new Map(
		(run?.plan?.scenarios ?? []).map((x) => [x.id, x.text] as const),
	);
	const out = Object.entries(ev as Record<string, unknown>).map(
		([id, v]) => `${id}${text.get(id) ? ` ${text.get(id)}` : ""}: ${String(v)}`,
	);
	return out.length ? out.join("\n") : undefined;
}

export function rightOf(
	ctx: Ctx,
	e: Event,
	w: number,
	fold = !!e.phrase.fold,
): Line {
	if (fold) return rcell(ctx.g.fold, w, "dim");
	if (ctx.narrow || e.durationMs === undefined) return rcell("", w);
	return rcell(clock(e.durationMs), w, "dim");
}

export function quietDivider(ctx: Ctx, gapMs: number): Line {
	const text = `  ${clock(gapMs)} quiet  `;
	const n = Math.max(text.length + 2, ctx.size.cols - 8);
	const left = Math.floor((n - text.length) / 2);
	return [
		sp(ctx.narrow ? 2 : 3),
		{ text: ctx.g.quiet.repeat(left), role: "faint" },
		{ text, role: "dim" },
		{
			text: ctx.g.quiet.repeat(Math.max(0, n - text.length - left)),
			role: "faint",
		},
	];
}

export function activityBody(ctx: Ctx): {
	lines: Lazy[];
	sel?: number;
	items: number[];
	matched: number;
	total: number;
} {
	const h = home(ctx);
	const events = activityEvents(h, ctx.state);
	const total = Math.min(
		500,
		h.runs.reduce((n, r) => n + r.events.length, 0),
	);
	const sel = selectedId(
		ctx.state,
		"activity",
		events.map((e) => e.id),
	);
	const Kr = Math.max(8, ...h.runs.map((r) => r.key.length));
	const Kc = Math.max(8, ...events.map((e) => who(e).length));
	const lines: (Line | (() => Line))[] = [];
	const items: number[] = [];
	let at: number | undefined;
	let day: string | undefined;
	let prev: Event | undefined;
	const following = ctx.state.follow;
	const fresh = following
		? 0
		: Math.max(
				0,
				h.runs.reduce((n, r) => n + r.events.length, 0) -
					(ctx.state.pausedAt ?? 0),
			);
	const followText = following
		? ctx.narrow
			? "following"
			: "following · f to pause"
		: ctx.narrow
			? `paused · ${fresh}`
			: `paused · ${fresh} new`;
	for (const e of events) {
		const d = dayLabel(e.at, ctx.tick.now);
		if (d !== day) {
			if (day !== undefined) lines.push([]);
			const right: Line =
				day === undefined
					? [{ text: followText, role: following ? "dim" : "accent" }]
					: [];
			lines.push(asHead(lr(label(ctx, d), right, ctx.W)));
			day = d;
		} else if (prev && ms(prev.at) - ms(e.at) > QUIET_GAP)
			lines.push(quietDivider(ctx, ms(prev.at) - ms(e.at)));
		const isSel = e.id === sel;
		const more = unfolded(h, e);
		const open = !!more && ctx.state.expanded.includes(e.id);
		const row = () => activityRow(ctx, e, Kr, Kc, !!more && !open);
		if (isSel) at = lines.length;
		items.push(lines.length);
		lines.push(isSel ? selected(ctx, row()) : row);
		if (open && more)
			lines.push(...quote(ctx, more, ctx.narrow ? 11 : 14, 12, e.phrase.role));
		prev = e;
	}
	if (!events.length)
		lines.push([sp(3), { text: "nothing matches the filter", role: "dim" }]);
	return {
		lines,
		sel: at,
		items,
		matched: events.length,
		total,
	};
}

function activityRow(
	ctx: Ctx,
	e: Event,
	Kr: number,
	Kc: number,
	fold: boolean,
): Line {
	const time = hhmm(e.at, !ctx.narrow);
	if (ctx.narrow) {
		// Column 2, under the day label, as the narrow timeline does.
		const fixed = 2 + 5 + 2 + Kc + 2 + 14 + 1 + 1 + 1;
		return [
			sp(2),
			{ text: time, role: "dim" },
			sp(2),
			{ text: who(e).padEnd(Kc), role: "ink2" },
			sp(2),
			...eventSpans(ctx, e, 12, ctx.W - fixed),
			sp(1),
			...rightOf(ctx, e, 1, fold),
		];
	}
	const fixed = 3 + 8 + 3 + Kr + 2 + Kc + 3 + 14 + 1 + 1 + 7;
	return [
		sp(3),
		{ text: time, role: "dim" },
		sp(3),
		{ text: e.run.padEnd(Kr), role: "ink2" },
		sp(2),
		{ text: who(e).padEnd(Kc), role: "ink2" },
		sp(3),
		...eventSpans(ctx, e, 12, ctx.W - fixed),
		sp(1),
		...rightOf(ctx, e, 7, fold),
	];
}

const ACTIVITY_HINTS = [
	"↑↓ move",
	"⏎ expand",
	"→ open child",
	"f follow",
	"/ filter",
	"m machine",
	"← home",
	"? help",
	"q quit",
];

/** Every run's rows merged, newest first: the page beside Home that replaces a per-run timeline. */
export function activityScreen(ctx: Ctx): Line[] {
	const body = activityBody(ctx);
	const crumbs: Line[] = [[{ text: "activity", role: "ink" }]];
	const right = censusCompact(ctx, Math.floor(ctx.W / 2));
	const sub: Line = ctx.state.filter?.text
		? lr([], matchRight(ctx, body.matched, body.total, "rows"), ctx.W)
		: ctx.narrow
			? []
			: [sp(indent(ctx)), { text: "every run, newest first", role: "dim" }];
	return compose(ctx, {
		top: [...pageHeader(ctx, crumbs, right), rule(ctx), sub, []],
		body: body.lines,
		sel: body.sel,
		items: body.items,
		scrollKey: "activity",
		footer: footer(ctx, hints(ctx, ACTIVITY_HINTS), {
			m: body.matched,
			n: body.total,
		}),
	});
}
