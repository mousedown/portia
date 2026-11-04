import { span, tokens } from "../model/format";
import type { Progress } from "../model/progress";
import type { ChildView, Role, RunView } from "../model/types";
import type { Ctx } from "./common";
import { flash, spin } from "./common";
import { runGlyph } from "./glyphs";
import { fgOf } from "./ink";
import { type Line, rcell, type Span, sp, strWidth } from "./text";

/**
 * What the fill says: quiet while all is well, amber while a person must judge, rose
 * when something failed. Colour goes only where the run needs you.
 */
export type Tone = "accent" | "warn" | "failed";

/** The smallest a bar gets before anything else on its row gives way. */
export const BAR_MIN = 8;
/** Where a bar stops shrinking until the summary has been cut to its least. */
export const BAR_MID = 12;
/** A bar's width when the row has the room. */
export const BAR_MAX = 20;

/**
 * How much of a `w`-cell bar `done` of `total` fills: whole cells and the eighths of the
 * edge cell. Anything started shows at least an eighth, and anything short of done
 * leaves at least an eighth of track, so 0% and 100% are the only empty and full bars.
 */
export function barCells(
	done: number,
	total: number,
	w: number,
): { full: number; part: number } {
	if (w <= 0 || total <= 0 || done <= 0) return { full: 0, part: 0 };
	if (done >= total) return { full: w, part: 0 };
	let e = Math.round((done / total) * w * 8);
	e = Math.min(w * 8 - 1, Math.max(1, e));
	return { full: Math.floor(e / 8), part: e % 8 };
}

/** The same fill in whole ASCII cells: never empty once started, never full until done. */
export function asciiCells(done: number, total: number, w: number): number {
	if (w <= 0 || total <= 0 || done <= 0) return 0;
	if (done >= total) return w;
	return Math.min(w - 1, Math.max(1, Math.round((done / total) * w)));
}

/**
 * A thin rule: `━━━━━╸────`, the fill on a faint track, with a half cell `╸` at the edge
 * when the fill ends in the cell's second half or the bar has barely started. In ASCII
 * it is `=` on `-`. The fill is in the quiet ink unless the tone needs you.
 */
export function progressBar(
	ctx: Ctx,
	done: number,
	total: number,
	w: number,
	tone: Tone,
): Span[] {
	if (w <= 0) return [];
	const role: Role = tone === "accent" ? "ink2" : tone;
	if (!ctx.ink.unicode) {
		const n = asciiCells(done, total, w);
		return [
			{ text: "=".repeat(n), role },
			{ text: "-".repeat(w - n), role: "faint" as Role },
		].filter((s) => s.text);
	}
	const { full, part } = barCells(done, total, w);
	// Anything started shows at least the half cell, and anything short of done ends in
	// one or in track, never in a whole cell: only 100% is a solid rule.
	const half = part >= 4 || (full === 0 && part > 0) ? 1 : 0;
	const fill = full;
	const rest = w - fill - half;
	// The warn role is reverse video at 16 colours, which would draw the rule in the
	// background colour; the bar takes the plain amber instead.
	const ink: Pick<Span, "role" | "fg"> =
		tone === "warn" && ctx.ink.depth === 16
			? { fg: { ...fgOf("warn", ctx.ink.theme), c16: "33" } }
			: { role };
	return [
		{ text: "━".repeat(fill), ...ink },
		{ text: half ? "╸" : "", ...ink },
		{ text: "─".repeat(rest), role: "faint" as Role },
	].filter((s) => s.text);
}

export function runTone(r: RunView): Tone {
	if (r.glyph === "failed") return "failed";
	if (
		r.group === "waiting" ||
		r.group === "judgement" ||
		r.children.some((c) => c.state === "parked")
	)
		return "warn";
	return "accent";
}

export function childrenTone(children: ChildView[]): Tone {
	if (children.some((c) => c.state === "failed")) return "failed";
	if (children.some((c) => c.state === "parked")) return "warn";
	return "accent";
}

/**
 * A run's glyph on its progress row: a spinner while it works, `!` amber while it waits
 * on a person, `✗` rose when it failed, `●` gold once delivered, a dim `◐` while it
 * has gone quiet, and `○` at rest.
 */
export function progressGlyph(ctx: Ctx, r: RunView): Span {
	if (r.glyph === "running") return spin(ctx, r.key);
	const g = ctx.g.state;
	const [text, role]: [string, Role] =
		r.glyph === "parked"
			? [g.parked, "warn"]
			: r.glyph === "failed"
				? [g.failed, "failed"]
				: r.glyph === "delivered"
					? [g.done, "accent"]
					: r.glyph === "quiet"
						? [runGlyph(ctx.g, "quiet"), "dim"]
						: [g.ready, "dim"];
	return flash(ctx, r.key, { text, role });
}

/** The widths of the figures after a bar, shared by every row so they read as columns. */
export interface StatCols {
	/** `landed/total`, or an attempt. */
	N: number;
	/** The elapsed time. */
	D: number;
	/** The token figure, without the `+` of a child still counting. */
	T: number;
	/** A cell after the figure for that `+`, when any row has one. */
	plus: boolean;
	/** Whether the tokens show at all; they go last, after the bar and the summary give way. */
	tok: boolean;
	/** Whether the word `tokens` follows the figure; it goes first. */
	word: boolean;
}

const SEP = "   ";

export const statsWidth = (c: StatCols): number =>
	c.N +
	SEP.length +
	c.D +
	(c.tok ? SEP.length + c.T + (c.plus ? 1 : 0) + (c.word ? 7 : 0) : 0);

const counting = (t?: string) => !!t?.endsWith("+");

/** The figures' text widths over many rows, for `StatCols`. */
export function statWidths(
	rows: { n: string; d?: string; t?: string }[],
): Pick<StatCols, "N" | "D" | "T" | "plus"> {
	const t = (r: { t?: string }) => (r.t ?? "").replace(/\+$/, "");
	return {
		N: Math.max(3, ...rows.map((r) => strWidth(r.n))),
		// Fixed, so a ticking clock never moves the columns after it: `span` is at most
		// six cells under a hundred days.
		D: Math.max(6, ...rows.map((r) => strWidth(r.d ?? ""))),
		T: Math.max(3, ...rows.map((r) => strWidth(t(r)))),
		plus: rows.some((r) => counting(r.t)),
	};
}

/** `ms` as a span; a live one under an hour shows seconds, so the frame repaints each second. */
export function elapsedText(
	ctx: Ctx,
	elapsedMs: number | undefined,
	live: boolean,
): string | undefined {
	if (elapsedMs === undefined || Number.isNaN(elapsedMs)) return undefined;
	if (live && elapsedMs < 3_600_000) ctx.flags.seconds = true;
	return span(elapsedMs);
}

export const tokensText = (n: number): string | undefined =>
	n ? tokens(n) : undefined;

/** The progress figures for a run or a wave. */
export function progressFigures(
	ctx: Ctx,
	p: Progress,
): { n: string; d?: string; t?: string } {
	return {
		n: p.total ? `${p.done}/${p.total}` : "—",
		d: elapsedText(ctx, p.elapsedMs, p.live),
		t: tokensText(p.tokens),
	};
}

/**
 * `n   elapsed   tokens`, in the quiet tone, exactly `statsWidth(c)` cells. With no
 * time and no tokens yet only the first figure shows; a missing figure leaves its column
 * blank so the ones after it stay put.
 */
export function statsLine(
	c: StatCols,
	f: { n: string; d?: string; t?: string; nRole?: Role },
): Line {
	const w = statsWidth(c);
	const out: Line = [...rcell(f.n, c.N, f.nRole ?? "ink2")];
	if (f.d === undefined && f.t === undefined) return [...out, sp(w - c.N)];
	out.push({ text: SEP, role: "faint" }, ...rcell(f.d ?? "", c.D, "dim"));
	if (c.tok) {
		const plus = c.plus ? 1 : 0;
		if (f.t === undefined) out.push(sp(SEP.length + c.T + plus));
		else
			out.push(
				{ text: SEP, role: "faint" },
				...rcell(f.t.replace(/\+$/, ""), c.T, "dim"),
				// The word sits right after the figure; the `+` cell goes after it, where
				// a blank at the row's end cannot be seen.
				...(c.word ? [{ text: " tokens", role: "faint" as const }] : []),
				...(plus
					? [counting(f.t) ? { text: "+", role: "dim" as const } : sp(1)]
					: []),
			);
		if (c.word && f.t === undefined) out.push(sp(7));
	}
	return out;
}
