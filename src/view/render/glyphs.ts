import type { ChildState } from "../../core/types";
import type { CellKind, EventGlyph, RunGlyph } from "../model/types";

const U = {
	state: {
		pending: "·",
		ready: "○",
		running: "◐",
		parked: "!",
		failed: "✗",
		done: "●",
		landed: "✓",
		closed: "–",
	} as Record<ChildState, string>,
	spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	settle: "⠿",
	event: {
		dispatched: "▸",
		envUp: "↑",
		envDown: "↓",
		pass: "✓",
		fail: "✗",
		result: "●",
		parked: "!",
		accept: "≡",
		retry: "↻",
		epic: "◆",
	} as Record<EventGlyph, string>,
	cell: { pass: "✓", fail: "✗", unrun: "○", active: "○", gap: " " } as Record<
		CellKind,
		string
	>,
	matrix: { pass: "✓", fail: "✗", none: "·" },
	sel: "▌",
	crumb: "›",
	rule: "─",
	bar: "━",
	quiet: "┄",
	ellipsis: "…",
	quote: "▎",
	fold: "⏎",
	heartbeat: "●",
	caret: "▏",
	card: { tl: "╭", tr: "╮", bl: "╰", br: "╯", v: "│", h: "─" },
	finial: "◆",
	mark: "◆",
	up: "↑",
	down: "↓",
	keys: {
		updown: "↑↓",
		enter: "⏎",
		up: "↑",
		down: "↓",
		left: "←",
		right: "→",
	},
	dash: "—",
	dot: "·",
	check: "✓",
	cross: "✗",
	sep: "│",
	/** Sparkline levels, lowest first. */
	spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
	/** A sparkline cell with no reading: never the lowest level, which would read as 0%. */
	nodata: "·",
	/** Before a figure past its threshold, so it shows without colour too. */
	alert: "▲",
	/** A size bar's cells and eighths; `half` ends a gauge's thin rule. */
	meter: {
		half: "╸",
		l: "▕",
		r: "▏",
		full: "█",
		// No one-eighth cell: beside the end it would read as the end.
		parts: ["", "", "▎", "▍", "▌", "▋", "▊", "▉"],
		empty: "░",
	},
};
export type Glyphs = typeof U;

const A: Glyphs = {
	...U,
	state: {
		pending: ".",
		ready: "o",
		running: "~",
		parked: "!",
		failed: "x",
		done: "*",
		landed: "+",
		closed: "-",
	},
	spinner: ["|", "/", "-", "\\"],
	settle: "*",
	event: {
		dispatched: ">",
		envUp: "^",
		envDown: "v",
		pass: "+",
		fail: "x",
		result: "*",
		parked: "!",
		accept: "=",
		retry: "r",
		epic: "#",
	},
	cell: { pass: "#", fail: "x", unrun: ".", active: ":", gap: " " },
	matrix: { pass: "+", fail: "x", none: "." },
	sel: ">",
	crumb: ">",
	rule: "-",
	bar: "=",
	quiet: ".",
	ellipsis: "~",
	quote: "|",
	fold: "+",
	heartbeat: "*",
	caret: "|",
	card: { tl: "+", tr: "+", bl: "+", br: "+", v: "|", h: "-" },
	finial: "o",
	mark: "o",
	up: "^",
	down: "v",
	keys: {
		updown: "up/dn",
		enter: "enter",
		up: "up",
		down: "dn",
		left: "left",
		right: "right",
	},
	dash: "-",
	dot: ".",
	check: "+",
	cross: "x",
	sep: "|",
	spark: ["_", ".", "-", "~", "=", "+", "*", "#"],
	nodata: " ",
	alert: "!",
	meter: {
		half: "",
		l: "[",
		r: "]",
		full: "#",
		parts: ["", "", "", "", "=", "=", "=", "="],
		empty: ".",
	},
};

export const glyphs = (unicode: boolean): Glyphs => (unicode ? U : A);

/** FNV-1a, 32-bit: offsets each child's spinner so a wave never spins in lockstep. */
export function fnv(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export function spinner(
	g: Glyphs,
	key: string,
	now: number,
	motion: boolean,
): string {
	// Still, a running child keeps a spinner's shape: ◐ is the quiet one's.
	if (!motion) return g.spinner[0] ?? g.state.running;
	const n = g.spinner.length;
	return (
		g.spinner[(Math.floor(now / 100) + (fnv(key) % n)) % n] ?? g.state.running
	);
}

export const runGlyph = (g: Glyphs, r: RunGlyph): string =>
	r === "delivered"
		? g.state.landed
		: r === "empty"
			? g.state.pending
			: r === "quiet"
				? g.state.running
				: g.state[r];
