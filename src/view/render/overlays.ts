import { completions } from "../runtime/state";
import { type Ctx, indent, keyNames, STATE_ROLE, spin } from "./common";
import {
	type Line,
	lineWidth,
	lr,
	overlay,
	pad,
	type Span,
	sp,
	truncate,
} from "./text";

/** The footer, unless the filter or the command line has taken it; a toast shows above it. */
export function footer(
	ctx: Ctx,
	hintsLine: Line,
	match?: { m: number; n: number },
): Line {
	const { state } = ctx;
	const at = indent(ctx) === 3 ? 2 : 2;
	if (state.command) return commandLine(ctx);
	if (state.filter?.editing) {
		const right: Line = match
			? [
					{
						text: `${match.m} of ${match.n} · ${ctx.g.keys.enter} keep · esc clear`,
						role: "dim",
					},
				]
			: [{ text: "esc clear", role: "dim" }];
		return lr(
			[
				sp(at),
				{ text: "/ ", role: "accent" },
				{ text: state.filter.text, role: "ink" },
				{ text: ctx.g.caret, role: "accent" },
			],
			right,
			ctx.W,
		);
	}
	return hintsLine;
}

export function deadline(ctx: Ctx, at: number): void {
	const d = ctx.flags as { deadline?: number };
	d.deadline = d.deadline === undefined ? at : Math.min(d.deadline, at);
}

function commandLine(ctx: Ctx): Line {
	const text = ctx.state.command?.text ?? "";
	const cands = completions(text, ctx.models.home, ctx.state.runKey);
	const word = text.split(" ").at(-1) ?? "";
	const first = cands[0] ?? "";
	const ghost = first.toLowerCase().startsWith(word.toLowerCase())
		? first.slice(word.length)
		: "";
	const left: Line = [
		sp(2),
		{ text: ": ", role: "accent" },
		{ text, role: "ink" },
		{ text: ctx.g.caret, role: "accent" },
		{ text: ghost, role: "faint" },
	];
	const room = ctx.W - lineWidth(left) - 2;
	const list = cands.join(ctx.narrow ? " " : " · ");
	const right: Line =
		room > 4 && list ? truncate([{ text: list, role: "dim" }], room) : [];
	return lr(left, right, ctx.W);
}

/** Everything behind an overlay, in faint: the same text, every role faint, no background. */
export const faint = (l: Line): Line =>
	l.map((s) => ({ text: s.text, role: s.text.trim() ? "faint" : undefined }));

const ROWS: [string, string, string, string][] = [
	["move", "↑ ↓  j k", "top / bottom", "home  end"],
	["open", "→  ⏎  l", "back", "←  esc  h"],
	["activity", "a", "machine", "m"],
	["gate matrix", "g", "worker log", "w"],
	["filter", "/", "next match", "n  N"],
	["open the PR", "o", "epic diff", "d"],
	["copy", "y", "editor", "e"],
	["follow", "f", "sort runs", "s"],
	["new run", "n", "re-read", "r"],
	["half page", "^d  ^u", "archive run", "x x"],
	["question text", "PgUp  PgDn", "quit", "q"],
];
const EPIGRAPH = "the quality of mercy is not strained";

/** The help card, 65 cells wide when there is room. */
export function helpCard(ctx: Ctx): Line[] {
	const g = ctx.g;
	const inner = Math.min(63, ctx.size.cols - 4);
	const border = (t: string): Span => ({ text: t, role: "rule" });
	const title = " keys ";
	const left = Math.floor((inner - title.length) / 2);
	const row = (content: Line): Line => [
		border(g.card.v),
		...pad(truncate(content, inner), inner),
		border(g.card.v),
	];
	const out: Line[] = [
		[
			border(g.card.tl + g.card.h.repeat(left)),
			{ text: title, role: "dim" },
			border(g.card.h.repeat(inner - left - title.length) + g.card.tr),
		],
		row([]),
		row([
			sp(2),
			{ text: "pages          ", role: "ink2" },
			{ text: "Home › Run › Child › Worker", role: "accentBright" },
		]),
		row([]),
	];
	const padTo = (t: string, w: number) =>
		t + " ".repeat(Math.max(0, w - t.length));
	for (const [a, b, c, d] of ROWS)
		out.push(
			row([
				sp(2),
				{ text: padTo(a, 14), role: "ink2" },
				{ text: padTo(keyNames(ctx, b), 17), role: "accentBright" },
				{ text: padTo(c, 15), role: "ink2" },
				{ text: keyNames(ctx, d), role: "accentBright" },
			]),
		);
	out.push(row([]));
	out.push(
		row([
			sp(2),
			{ text: "filter words   ", role: "ink2" },
			{ text: "state:parked  wave:2  model:opus  live", role: "accentBright" },
		]),
	);
	const legend = (pairs: [Span, string][]): Line =>
		pairs.flatMap(([glyph, word], i) => [
			...(i ? [sp(2)] : []),
			glyph,
			{ text: ` ${word}`, role: "ink2" as const },
		]);
	const st = (k: keyof typeof STATE_ROLE): Span => ({
		text: g.state[k],
		role: STATE_ROLE[k],
	});
	out.push(
		row([
			sp(2),
			{ text: "glyphs   ", role: "ink2" },
			...legend([
				[st("pending"), "pending"],
				[st("ready"), "ready"],
				[spin(ctx, "help"), "running"],
				[st("parked"), "parked"],
				[st("failed"), "failed"],
			]),
		]),
	);
	out.push(
		row([
			sp(11),
			...legend([
				[st("done"), "done"],
				[st("landed"), "landed"],
				[st("closed"), "closed"],
				[{ text: g.state.running, role: "dim" }, "quiet"],
			]),
		]),
	);
	const tone = (text: string, role: Span["role"]): Span => ({ text, role });
	out.push(
		row([
			sp(2),
			{ text: "waves    ", role: "ink2" },
			tone(g.check, "landed"),
			{ text: " landed  ", role: "ink2" },
			spin(ctx, "help-wave"),
			{ text: " working  ", role: "ink2" },
			tone(g.dot, "faint"),
			{ text: " pending  ", role: "ink2" },
			{ text: "gap: next wave", role: "dim" },
		]),
	);
	out.push(
		row([
			sp(2),
			{ text: "gate pips  ", role: "ink2" },
			{ text: "task ", role: "dim" },
			tone(g.cell.pass.repeat(3), "done"),
			{ text: "  exit ", role: "dim" },
			tone(g.cell.pass.repeat(4), "done"),
			tone(g.cell.fail, "failed"),
			tone(g.cell.unrun.repeat(2), "faint"),
			{ text: "  one per step", role: "dim" },
		]),
	);
	out.push(row([]));
	const e = Math.max(0, Math.floor((inner - EPIGRAPH.length) / 2));
	out.push(row([sp(e), { text: EPIGRAPH, role: "dim", italic: true }]));
	out.push([border(g.card.bl + g.card.h.repeat(inner) + g.card.br)]);
	return out;
}

/** One clear cell either side of the card, so no fragment of the backdrop touches its border. */
function clearAround(l: Line, at: number, w: number, total: number): Line {
	const from = Math.max(0, at - 1);
	return overlay(l, [sp(Math.min(total, at + w + 1) - from)], from, total);
}

/** The help card over the frame: the header stays, the rest goes faint behind it. */
export function withHelp(ctx: Ctx, lines: Line[], headerRows = 2): Line[] {
	const card = helpCard(ctx);
	const w = lineWidth(card[0] ?? []);
	const off = Math.max(0, Math.floor((ctx.size.cols - w) / 2));
	const top = 3;
	// Faint reads as normal text without colour, and a thin margin leaves cut words
	// against the border: then the rows the card covers are blanked instead.
	const blank = ctx.ink.depth === 0 || off < 8;
	const out = lines.map((l, i) => (i < headerRows ? l : faint(l)));
	card.forEach((c, i) => {
		const r = top + i;
		if (r >= out.length - 2) return;
		const base = blank ? [] : clearAround(out[r] ?? [], off, w, ctx.W);
		out[r] = overlay(base, c, off, ctx.W);
	});
	out[out.length - 1] = [
		sp(indent(ctx)),
		{ text: "esc or ? closes", role: "dim" },
	];
	return out;
}
