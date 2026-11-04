import { type Ctx, indent } from "./common";
import { deadline } from "./overlays";
import {
	isHead,
	type Line,
	lineWidth,
	lr,
	type Span,
	sp,
	truncate,
} from "./text";

export const MIN = { cols: 60, rows: 16 };

/** A body line, or one built only if it is scrolled into view. */
export type Lazy = Line | (() => Line);

export interface Parts {
	top: Line[];
	body: Lazy[];
	/** The body line the cursor is on, kept at least 2 rows from either edge. */
	sel?: number;
	/** The body lines that are items, which the more-markers count; every line when absent. */
	items?: number[];
	scrollKey?: string;
	dock?: Line[];
	footer: Line;
	/**
	 * Fill the viewport to the more-marker: the next section's label and its first lines
	 * show at the bottom, rather than going below the fold with the rest of it.
	 */
	fill?: boolean;
}

/** Where a scroll offset must move so `sel` stays 2 rows inside an `h`-row window. */
export function scrollTo(
	prev: number,
	sel: number | undefined,
	h: number,
	n: number,
): number {
	let s = prev;
	if (sel !== undefined) {
		const margin = Math.min(2, Math.floor((h - 1) / 2));
		if (sel < s + margin) s = sel - margin;
		if (sel > s + h - 1 - margin) s = sel - h + 1 + margin;
	}
	return Math.max(0, Math.min(s, Math.max(0, n - h)));
}

/** `↓ 3 more` counts items; with only labels and prose left out of view, plain `↓ more`. */
const more = (arrow: string, n: number): Span => ({
	text: n > 0 ? `${arrow} ${n} more` : `${arrow} more`,
	role: "dim",
});

/** Exactly `rows` lines, none wider than `cols − 1`: top, scrolled body, dock, blank, footer. */
export function compose(ctx: Ctx, p: Parts): Line[] {
	const { rows } = ctx.size;
	let dock = p.dock ?? [];
	let h = rows - p.top.length - dock.length - 2;
	if (h < 3 && dock.length) {
		dock = [];
		h = rows - p.top.length - 2;
	}
	h = Math.max(0, h);
	const n = p.body.length;
	const key = p.scrollKey;
	const prev = key ? (ctx.state.scroll[key] ?? 0) : 0;
	// Each marker takes a row of its own, so the viewport shrinks by the markers it needs.
	let s = scrollTo(prev, p.sel, h, n);
	let view = h;
	let up = false;
	let down = false;
	if (n > h && h >= 3) {
		s = scrollTo(prev, p.sel, h - 2, n);
		up = s > 0;
		down = s + h - 2 < n;
		view = h - (up ? 1 : 0) - (down ? 1 : 0);
		// At the bottom, the row the down marker would take shows one more line above.
		if (up && !down) s = n - view;
	}
	if (key) ctx.scroll[key] = s;
	ctx.flags.atEnd = !down;
	// Headings and blanks are always built; a lazy line is content, built only if shown.
	const build = (i: number): Line => {
		const l = p.body[i];
		return typeof l === "function" ? l() : (l ?? []);
	};
	const blank = (l: Lazy | undefined) =>
		!l || (typeof l !== "function" && lineWidth(l) === 0);
	const head = (l: Lazy | undefined) => typeof l !== "function" && isHead(l);
	// A heading whose items are all below the fold goes below it with them; a page that
	// fills its viewport keeps it, with the blanks that lead up to it.
	if (down && !p.fill)
		while (
			view > 1 &&
			s + view - 1 > (p.sel ?? -1) &&
			(head(p.body[s + view - 1]) || blank(p.body[s + view - 1]))
		)
			view--;
	// A group whose items start above the viewport repeats its heading under the marker.
	let sticky: Line | undefined;
	if (up && view > 1 && p.sel !== s && !head(p.body[s]) && !blank(p.body[s]))
		for (let i = s - 1; i >= 0; i--) {
			const l = p.body[i];
			if (blank(l)) break;
			if (head(l)) {
				sticky = build(i);
				break;
			}
		}
	const count = (from: number, to: number) =>
		p.items ? p.items.filter((i) => i >= from && i < to).length : to - from;
	const body: Line[] = [];
	if (up)
		body.push(lr([], [more(ctx.g.up, count(0, sticky ? s + 1 : s))], ctx.W));
	if (sticky) body.push(sticky);
	for (let i = sticky ? s + 1 : s; i < Math.min(n, s + view); i++)
		body.push(build(i));
	if (down) body.push(lr([], [more(ctx.g.down, count(s + view, n))], ctx.W));
	while (body.length < h) body.push([]);
	const out = [...p.top, ...body, ...dock, toastRow(ctx), p.footer].slice(
		0,
		rows,
	);
	while (out.length < rows) out.push([]);
	return out.map((l) => (lineWidth(l) > ctx.W ? truncate(l, ctx.W) : l));
}

/**
 * The row above the footer: blank, or a toast while it lasts. The footer's keys stay
 * where they are, and the next key clears it.
 */
function toastRow(ctx: Ctx): Line {
	const t = ctx.state.toast;
	if (
		!t ||
		t.until <= ctx.tick.now ||
		ctx.state.command ||
		ctx.state.filter?.editing
	)
		return [];
	deadline(ctx, t.until);
	return truncate([sp(indent(ctx)), { text: t.text, role: t.role }], ctx.W);
}

export function tooSmall(ctx: Ctx): Line[] {
	const text = `portia view needs at least ${MIN.cols} ${ctx.ink.unicode ? "×" : "x"} ${MIN.rows}`;
	const { rows, cols } = ctx.size;
	const out: Line[] = Array.from({ length: rows }, () => []);
	const w = Math.min(text.length, cols - 1);
	out[Math.floor(rows / 2)] = [
		sp(Math.max(0, Math.floor((cols - 1 - w) / 2))),
		{ text: text.slice(0, w), role: "dim" },
	];
	return out;
}
