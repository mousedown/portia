import type { Role } from "../model/types";

/** A colour outside the role palette: the logo's gradients and the breath. */
export interface Fg {
	hex: string;
	c256: number;
	c16?: string;
}
export interface Span {
	text: string;
	role?: Role;
	fg?: Fg;
	/** A background, at 256 colours and above only; it wins over the selection's. */
	bg?: Fg;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	sel?: boolean;
	/** Reverse video: the tab bar's current tab. */
	reverse?: boolean;
	/** A URL the terminal opens on cmd-click (OSC 8); painted only when the ink allows links. */
	link?: string;
}
export type Line = Span[];

const ZERO: [number, number][] = [
	[0x0300, 0x036f],
	[0x0483, 0x0489],
	[0x0591, 0x05bd],
	[0x0610, 0x061a],
	[0x064b, 0x065f],
	[0x0e31, 0x0e31],
	[0x0e34, 0x0e3a],
	[0x1ab0, 0x1aff],
	[0x1dc0, 0x1dff],
	[0x200b, 0x200f],
	[0x20d0, 0x20ff],
	[0xfe00, 0xfe0f],
	[0xfe20, 0xfe2f],
	[0xe0100, 0xe01ef],
];
// East Asian Wide, plus the characters whose default presentation is emoji (✅ ❌ ⭐ 🫠),
// which terminals draw two cells wide. Text-presentation symbols such as ✓ ✗ ✔ stay one.
const WIDE: [number, number][] = [
	[0x1100, 0x115f],
	[0x231a, 0x231b],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f2ff],
	[0x1f300, 0x1f64f],
	[0x1f680, 0x1f6ff],
	[0x1f7e0, 0x1f7eb],
	[0x1f900, 0x1f9ff],
	[0x1fa70, 0x1faff],
	[0x20000, 0x3fffd],
];
const inRange = (cp: number, table: [number, number][]) =>
	table.some(([a, b]) => cp >= a && cp <= b);

/**
 * 0 for combining marks, ZWJ and selectors; 2 for wide and emoji; 1 for the rest. A
 * control character is 1, because the painter draws it as a space. U+FE0F counts 0
 * and the painter drops it, so ✔️ is drawn, and measured, as the one-cell ✔.
 */
export function cellWidth(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (cp === 0x200d) return 0;
	if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 1;
	if (cp < 0x300) return 1;
	if (inRange(cp, ZERO)) return 0;
	return inRange(cp, WIDE) ? 2 : 1;
}

export const strWidth = (s: string): number => {
	let w = 0;
	for (const ch of s) w += cellWidth(ch);
	return w;
};

export const lineWidth = (l: Line): number =>
	l.reduce((w, s) => w + strWidth(s.text), 0);

export const sp = (n: number, sel?: boolean): Span => ({
	text: " ".repeat(Math.max(0, n)),
	sel,
});

/** Cuts text to at most w cells, ending in an ellipsis when cut. */
export function cut(s: string, w: number): string {
	if (w <= 0) return "";
	if (strWidth(s) <= w) return s;
	let out = "";
	let used = 0;
	for (const ch of s) {
		const cw = cellWidth(ch);
		if (used + cw > w - 1) break;
		out += ch;
		used += cw;
	}
	return `${out}…`;
}

/** Like cut, but always ends in an ellipsis: the text it ends has more after it. */
function cutAlways(s: string, w: number): string {
	if (w <= 0) return "";
	return strWidth(s) < w ? `${s}…` : cut(`${s}…`, w);
}

/** Cuts text to at most w cells from the left, keeping the tail after a leading ellipsis. */
export function cutLeft(s: string, w: number, mark = "…"): string {
	if (w <= 0) return "";
	if (strWidth(s) <= w) return s;
	const room = w - strWidth(mark);
	const chars = [...s];
	let out = "";
	let used = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const ch = chars[i] ?? "";
		const cw = cellWidth(ch);
		if (used + cw > room) break;
		out = ch + out;
		used += cw;
	}
	// Cut at a separator rather than mid-segment, unless that throws away too much.
	const slash = out.indexOf("/");
	if (slash > 0 && slash <= 8) out = out.slice(slash);
	return `${mark}${out}`;
}

/** Cuts a line to at most w cells; the ellipsis takes the style of the span it cut. */
export function truncate(l: Line, w: number): Line {
	if (lineWidth(l) <= w) return l;
	const out: Line = [];
	let used = 0;
	for (const span of l) {
		const sw = strWidth(span.text);
		// Strictly less: a span that ends exactly at w leaves no cell for the ellipsis
		// the spans after it are owed.
		if (used + sw < w) {
			out.push(span);
			used += sw;
			continue;
		}
		out.push({ ...span, text: cutAlways(span.text, w - used) });
		break;
	}
	// The cut may have left the ellipsis past w when the next span was cut to nothing.
	return lineWidth(out) > w ? truncate(out.slice(0, -1), w) : out;
}

export function pad(l: Line, w: number, sel?: boolean): Line {
	const lw = lineWidth(l);
	return lw >= w ? truncate(l, w) : [...l, sp(w - lw, sel)];
}

/** One span of exactly w cells, cut or padded. */
export function cell(
	text: string,
	w: number,
	role?: Role,
	o: Partial<Span> = {},
): Span[] {
	const t = cut(text, w);
	const gap = w - strWidth(t);
	return gap > 0
		? [{ ...o, text: t, role }, sp(gap)]
		: [{ ...o, text: t, role }];
}
export function rcell(
	text: string,
	w: number,
	role?: Role,
	o: Partial<Span> = {},
): Span[] {
	const t = cut(text, w);
	const gap = w - strWidth(t);
	return gap > 0
		? [sp(gap), { ...o, text: t, role }]
		: [{ ...o, text: t, role }];
}

/** Left and right on one line of `total` cells; the right side wins any contest for room. */
export function lr(left: Line, right: Line, total: number): Line {
	const rw = lineWidth(right);
	if (!rw) return pad(left, total);
	// Two cells between the sides, the gap the column grammar keeps everywhere else.
	const room = total - rw - 2;
	if (room <= 0) return pad(truncate(right, total), total);
	const l = truncate(left, room);
	return [...l, sp(total - lineWidth(l) - rw), ...right];
}

/** Cells [from, to) of a line, splitting spans as needed. */
export function slice(l: Line, from: number, to: number): Line {
	const out: Line = [];
	let col = 0;
	for (const span of l) {
		let text = "";
		for (const ch of span.text) {
			const cw = cellWidth(ch);
			if (col >= from && col + cw <= to) text += ch;
			else if (col < to && col + cw > from) text += " ";
			col += cw;
		}
		if (text) out.push({ ...span, text });
		if (col >= to) break;
	}
	return out;
}

/** Splices `over` onto `base` at column `at`. */
export function overlay(
	base: Line,
	over: Line,
	at: number,
	total: number,
): Line {
	const b = pad(base, total);
	const w = lineWidth(over);
	return [...slice(b, 0, at), ...over, ...slice(b, at + w, total)];
}

/** Greedy word wrap to w cells; a word longer than w is cut. */
export function wrap(text: string, w: number): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		let line = "";
		for (const word of raw.split(/\s+/).filter(Boolean)) {
			if (!line) line = word;
			else if (strWidth(line) + 1 + strWidth(word) <= w) line += ` ${word}`;
			else {
				out.push(line);
				line = word;
			}
		}
		out.push(line);
	}
	return out.map((l) => cut(l, w));
}

const ASCII: Record<string, string> = {
	"·": ".",
	"✓": "+",
	"✗": "x",
	"…": "~",
	"—": "-",
	"–": "-",
	"→": ">",
	"←": "<",
	"↑": "^",
	"↓": " ",
	"›": ">",
	"─": "-",
	"━": "=",
	"┄": ".",
	"│": "|",
	"╭": "+",
	"╮": "+",
	"╰": "+",
	"╯": "+",
	"▌": ">",
	"▎": "|",
	"▏": "|",
	"⏎": "+",
	"●": "*",
	"○": "o",
	"◐": "~",
	"◆": "o",
	"▰": "#",
	"▱": ".",
	"▸": ">",
	"↻": "r",
	"≡": "=",
	"⇧": "S",
	"⠿": "*",
	"“": '"',
	"”": '"',
	"‘": "'",
	"’": "'",
};

/** Every character as ASCII, keeping each one's width: the last word on PORTIA_ASCII. */
export function asciify(s: string): string {
	let out = "";
	for (const ch of s) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp < 0x80) out += ch;
		else out += ASCII[ch] ?? "?".repeat(cellWidth(ch));
	}
	return out;
}

const HEADS = new WeakSet<Line>();

/** Marks a body line as a heading (a section label, group header or attempt title). */
export function asHead(l: Line): Line {
	HEADS.add(l);
	return l;
}
export const isHead = (l: Line | undefined): boolean => !!l && HEADS.has(l);
