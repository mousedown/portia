import { homedir } from "node:os";
import type { ChildState } from "../../core/types";
import { age, clock, hhmm, span, tokens } from "../model/format";
import type { MachineView } from "../model/machine";
import type { ChildView, HomeView, Role, RunView } from "../model/types";
import type { ViewState } from "../runtime/state";
import { parseFilter, subsequence } from "../select";
import { type Glyphs, glyphs, runGlyph, spinner } from "./glyphs";
import { fgOf, type Ink, mix } from "./ink";
import {
	type ArrivalFrame,
	compact,
	type FinialState,
	type MarkForm,
	MINI_WIDTH,
	mini,
} from "./logo";
import {
	asHead,
	cut,
	cutLeft,
	type Line,
	lineWidth,
	lr,
	pad,
	type Span,
	sp,
	strWidth,
	truncate,
	wrap,
} from "./text";

export interface Size {
	cols: number;
	rows: number;
}
export interface Tick {
	now: number;
	/** Frozen (`--frame`): the breath holds at frame 12 and nothing arrives. */
	frozen?: boolean;
	arrival?: ArrivalFrame;
}
export interface Models {
	home: HomeView;
	/** The machine the view runs on; absent until the first sample. */
	machine?: MachineView;
	/** Each run's repository, `https://github.com/owner/repo`, once the runtime has found it. */
	repos?: Record<string, string>;
	/** The Jira site, for links to its issues. */
	jira?: string;
}
export interface Ctx {
	state: ViewState;
	models: Models;
	ink: Ink;
	g: Glyphs;
	size: Size;
	tick: Tick;
	narrow: boolean;
	/** Content cells per line: every column but the last. */
	W: number;
	/** Set when something on screen moves, or shows seconds; `atEnd` when the page is scrolled to its last row. */
	flags: { animating: boolean; seconds: boolean; atEnd?: boolean };
	/** Scroll offsets the frame settled on, for the runtime to keep. */
	scroll: Record<string, number>;
}

export function makeCtx(
	state: ViewState,
	models: Models,
	ink: Ink,
	size: Size,
	tick: Tick,
): Ctx {
	return {
		state,
		models,
		ink,
		g: glyphs(ink.unicode),
		size,
		tick,
		narrow: size.cols < 100,
		W: size.cols - 1,
		flags: { animating: false, seconds: false },
		scroll: { ...state.scroll },
	};
}

export const findRun = (ctx: Ctx, key?: string): RunView | undefined =>
	ctx.models.home.runs.find((r) => r.key === key);

export const STATE_ROLE: Record<ChildState, Role> = {
	pending: "pending",
	ready: "ready",
	running: "running",
	parked: "parked",
	failed: "failed",
	done: "done",
	landed: "landed",
	closed: "closed",
};

export function spin(ctx: Ctx, key: string): Span {
	if (ctx.ink.motion) ctx.flags.animating = true;
	return {
		text: spinner(ctx.g, key, ctx.tick.now, ctx.ink.motion),
		role: "running",
	};
}

/** A flash colours the glyph and key from accentBright towards their own colour (§13.1). */
export function flash(ctx: Ctx, id: string, span: Span): Span {
	const at = ctx.state.flashes[id];
	if (at === undefined || !ctx.ink.motion || ctx.tick.frozen) return span;
	const t = ctx.tick.now - at;
	if (t < 0 || t >= 600) return span;
	ctx.flags.animating = true;
	if (ctx.ink.depth !== 24) return { ...span, bold: true };
	const role = span.role ?? "ink";
	const to = fgOf(role, ctx.ink.theme);
	const from = fgOf("accentBright", ctx.ink.theme).hex;
	return {
		...span,
		fg: { ...to, hex: mix(from, to.hex, Math.min(1, Math.floor(t / 100) / 6)) },
	};
}

/** A child's glyph: a spinner while it runs, a still ◐ when it has gone quiet. */
export function childGlyph(ctx: Ctx, c: ChildView): Span {
	const settle = ctx.state.flashes[`settle:${c.key}`];
	if (
		settle !== undefined &&
		ctx.ink.motion &&
		!ctx.tick.frozen &&
		ctx.tick.now - settle < 200
	) {
		ctx.flags.animating = true;
		return { text: ctx.g.settle, role: STATE_ROLE[c.state] };
	}
	if (c.state === "running")
		return c.phase === "quiet"
			? { text: ctx.g.state.running, role: "dim" }
			: spin(ctx, c.key);
	return flash(ctx, c.key, {
		text: ctx.g.state[c.state],
		role: STATE_ROLE[c.state],
		bold: c.state === "landed",
	});
}

export function runGlyphSpan(ctx: Ctx, r: RunView): Span {
	if (r.glyph === "running") return spin(ctx, r.key);
	const role: Role =
		r.glyph === "delivered"
			? "accent"
			: r.glyph === "quiet" || r.glyph === "empty"
				? "dim"
				: STATE_ROLE[r.glyph as ChildState];
	return flash(ctx, r.key, {
		text: runGlyph(ctx.g, r.glyph),
		role,
		bold: r.glyph === "landed",
	});
}

/** §7.1: a person must judge, then something runs, else idle. */
export function finialState(home: HomeView): FinialState {
	if (home.runs.some((r) => r.group === "waiting" || r.group === "judgement"))
		return "parked";
	return home.runs.some((r) => r.group === "session") ? "running" : "idle";
}

export const finialOf = (ctx: Ctx): FinialState => finialState(ctx.models.home);

export function breathFrame(ctx: Ctx): number {
	if (ctx.tick.frozen) return 12;
	if (ctx.ink.depth === 24 && ctx.ink.motion && finialOf(ctx) === "running")
		ctx.flags.animating = true;
	return Math.floor(ctx.tick.now / 100) % 24;
}

export const mark = (ctx: Ctx, form: MarkForm): Line =>
	compact(ctx.ink, form, finialOf(ctx), breathFrame(ctx));

export const clockNow = (ctx: Ctx) => hhmm(ctx.tick.now);

/** Text with its ✓ ✗ · marks in their roles. */
export function marked(
	text: string,
	role: Role,
	o: Partial<Span> = {},
): Span[] {
	const out: Span[] = [];
	let buf = "";
	const flush = () => {
		if (buf) out.push({ ...o, text: buf, role });
		buf = "";
	};
	for (const ch of text) {
		const r: Role | undefined =
			ch === "✓" ? "done" : ch === "✗" ? "failed" : undefined;
		if (r) {
			flush();
			out.push({ ...o, text: ch, role: r });
		} else buf += ch;
	}
	flush();
	return out;
}

/** The header: the mark and breadcrumb on the left, the status cluster on the right. */
export function header(ctx: Ctx, left: Line, right: Line): Line {
	return lr([sp(1), ...left], right, ctx.W);
}

export const rule = (ctx: Ctx, from = 1): Line => [
	sp(from),
	{ text: ctx.g.rule.repeat(Math.max(0, ctx.W - from)), role: "rule" },
];

export const indent = (ctx: Ctx) => (ctx.narrow ? 2 : 3);

/** `WAITING ON YOU` or `W E D  2 9  O C T` as a plain heading: `waiting on you`, `wed 29 oct`. */
export const plainLabel = (text: string): string =>
	(/^(\S ){2,}/.test(text)
		? text.replace(/(\S) (?=\S)/g, "$1").replace(/ {2,}/g, " ")
		: text
	).toLowerCase();

/** A section heading in plain lower case, with a count on the right when one is given. */
export function label(
	ctx: Ctx,
	text: string,
	count?: number | string,
	at = indent(ctx),
): Line {
	const left: Line = [
		sp(at),
		{ text: plainLabel(text), role: "ink2", bold: true },
	];
	return asHead(
		count === undefined
			? left
			: lr(left, [{ text: String(count), role: "dim" }], ctx.W),
	);
}

/** The heartbeat flashes accentBright for 300 ms after each refresh. */
export function live(ctx: Ctx): Line {
	const at = ctx.state.refreshedAt;
	const lit =
		at !== undefined &&
		!ctx.tick.frozen &&
		ctx.tick.now - at < 300 &&
		ctx.ink.depth !== 0;
	if (lit) ctx.flags.animating = true;
	return [
		{ text: ctx.g.heartbeat, role: lit ? "accentBright" : "dim" },
		{ text: " live", role: "dim" },
	];
}

/** Key names in the glyph set's own words: in ASCII, ⏎ is `enter`, never the fold marker. */
export function keyNames(ctx: Ctx, s: string): string {
	const k = ctx.g.keys;
	return s
		.replaceAll("↑↓", k.updown)
		.replaceAll("⏎", k.enter)
		.replaceAll("↑", k.up)
		.replaceAll("↓", k.down)
		.replaceAll("←", k.left)
		.replaceAll("→", k.right);
}

/** Hints that go last when the footer is short of room: how to get help, back and out. */
const KEEP = /^(\? |← |q |esc )/;

/**
 * Key hints, each a key and the word for what it does, in the order they read: the key
 * bold in the ink, its word dim, a dot between. Short of room, the last one that is not
 * help, back or quit goes first, so every hint left still says what its key does.
 */
export function hints(ctx: Ctx, list: string[], withLive = true): Line {
	const sep = " · ";
	const at = indent(ctx);
	const right = withLive ? live(ctx) : [];
	const room = ctx.W - at - lineWidth(right) - 2;
	const raw = list.filter(Boolean);
	const width = () => strWidth(raw.map((h) => keyNames(ctx, h)).join(sep));
	while (raw.length > 1 && width() > room) {
		let i = raw.length - 1;
		while (i > 0 && KEEP.test(raw[i] ?? "")) i--;
		raw.splice(i, 1);
	}
	const left: Line = [sp(at)];
	raw.forEach((h, i) => {
		if (i) left.push({ text: sep, role: "faint" });
		const text = keyNames(ctx, h);
		const cut = text.indexOf(" ");
		if (cut < 0) left.push({ text, role: "ink2", bold: true });
		else
			left.push(
				{ text: text.slice(0, cut), role: "ink2", bold: true },
				{ text: text.slice(cut), role: "dim" },
			);
	});
	return lr(left, right, ctx.W);
}

/** Puts the gutter bar on a line and fills the selection background to the edge. */
export function selected(ctx: Ctx, line: Line, bar = true): Line {
	const body = pad(line, ctx.W).map((s) => ({ ...s, sel: true }));
	if (!bar) return body;
	const first = body[0];
	if (!first) return body;
	const rest = [...first.text].slice(1).join("");
	return [
		{ text: ctx.g.sel, role: "accent", sel: true },
		{ ...first, text: rest },
		...body.slice(1),
	];
}

export const ageOf = (ctx: Ctx, at?: string | number) =>
	at === undefined
		? ""
		: age(ctx.tick.now - (typeof at === "number" ? at : Date.parse(at)));

/**
 * Why a parked child waits, on one line: `waiting on you · 1h45m` for the person, or
 * `usage limit · frees 15:30` for a park the run clears itself. Undefined when nothing waits.
 */
export function waitHead(ctx: Ctx, c: ChildView): Span | undefined {
	const w = c.wait;
	if (!w) return undefined;
	if (w.kind === "question")
		return {
			text: `waiting on you · ${span(ctx.tick.now - Date.parse(w.at))}`,
			role: "parked",
			bold: true,
		};
	return {
		text: `usage limit · ${w.frees && !Number.isNaN(Date.parse(w.frees)) ? `frees ${hhmm(w.frees)}` : "frees when an account does"}`,
		role: "dim",
	};
}

export const tok = (n: number) => (n ? tokens(n) : "—");

/**
 * The header of every page but a tall Home: the mark, then where you are, `◆ P O R T I A ›
 * ACME-500 › ACME-505`, with the page's status on the right. Short of room the word
 * closes up, then only the finial is left.
 */
export function crumbHeader(ctx: Ctx, parts: Line[], right: Line): Line {
	const sep: Span = {
		text: ctx.narrow ? ` ${ctx.g.crumb} ` : `  ${ctx.g.crumb}  `,
		role: "dim",
	};
	const trail = parts.flatMap((p) => [sep, ...p]);
	// The keys must fit beside the word; a summary after a key is cut instead.
	const keys = parts.flatMap((p) => [sep, ...p.slice(0, 1)]);
	const room = ctx.W - 1 - lineWidth(right) - 2;
	const forms: MarkForm[] = ctx.narrow
		? ["narrow", "mark"]
		: ["wide", "narrow", "mark"];
	const form =
		forms.find((f) => lineWidth([...mark(ctx, f), ...trail]) <= room) ??
		forms.find((f) => lineWidth([...mark(ctx, f), ...keys]) <= room) ??
		"mark";
	return header(ctx, [...mark(ctx, form), ...trail], right);
}

/** A page the tab bar names: its key, when it has one, and its word. */
interface Tab {
	word: string;
	on: boolean;
}

/** The pages beside the one shown, as the tab bar lists them. */
function tabsOf(ctx: Ctx): Tab[] {
	const s = ctx.state;
	switch (s.screen) {
		case "home":
		case "activity":
		case "machine":
			return [
				{ word: "runs", on: s.screen === "home" },
				{ word: "activity", on: s.screen === "activity" },
				{ word: "machine", on: s.screen === "machine" },
			];
		case "run":
			return [
				{ word: "children", on: !s.matrix },
				{ word: "gate matrix", on: !!s.matrix },
			];
		default:
			return [
				{ word: "child", on: s.screen === "child" },
				{ word: "worker", on: s.screen === "worker" },
			];
	}
}

/**
 * `1 runs   2 activity   3 machine`: each page beside this one under its number key,
 * the one shown in reverse video. The text is the same at every depth, so without
 * colour nothing moves; the breadcrumb beside it says which page this is.
 */
export function tabBar(ctx: Ctx): Line {
	const out: Line = [];
	tabsOf(ctx).forEach((t, i) => {
		if (i) out.push(sp(2));
		const label = ` ${i + 1} ${t.word} `;
		out.push(
			t.on
				? { text: label, role: "ink", bold: true, reverse: true }
				: { text: label, role: "ink2" },
		);
	});
	return out;
}

/** Rows a page needs before its header takes two. */
const TALL_HEADER_ROWS = 24;

/**
 * The header of every page but Home: the two-row logo with where you are and the
 * page's status beside it, and the tab bar under them. Narrow, short or in ASCII it is
 * the one-line `◆ P O R T I A › …` header instead.
 */
export function pageHeader(ctx: Ctx, parts: Line[], right: Line): Line[] {
	if (ctx.narrow || !ctx.ink.unicode || ctx.size.rows < TALL_HEADER_ROWS)
		return [crumbHeader(ctx, parts, right)];
	const logo = mini(ctx.ink, finialOf(ctx), breathFrame(ctx));
	const sep: Span = { text: `  ${ctx.g.crumb}  `, role: "dim" };
	const trail = parts.flatMap((p, i) => (i ? [sep, ...p] : p));
	const lead = 1 + MINI_WIDTH + 3;
	const room = ctx.W - lead - lineWidth(right) - 2;
	const left = truncate(trail, Math.max(0, room));
	return [
		lr([sp(1), ...(logo[0] ?? []), sp(3), ...left], right, ctx.W),
		[sp(1), ...(logo[1] ?? []), sp(3), ...tabBar(ctx)],
	];
}

/**
 * Where the trail starts: `activity` when the page was reached from the Activity feed,
 * which is where ← goes back to; otherwise the run, and nothing before it.
 */
export function fromActivity(ctx: Ctx): boolean {
	const before = ctx.state.stack.filter(
		(p) => p.screen !== "child" && p.screen !== "worker",
	);
	return before.at(-1)?.screen === "activity";
}

/** The trail to a run's page: `ACME-500`, or `activity › ACME-500` from the feed. */
export function runCrumbs(ctx: Ctx, run: Line): Line[] {
	return fromActivity(ctx) ? [[{ text: "activity", role: "ink" }], run] : [run];
}

/** The trail to a child's page: `ACME-500 › ACME-505`, or `activity › ACME-505` from the feed. */
export function childCrumbs(ctx: Ctx, run: string, child: string): Line[] {
	return [
		[{ text: fromActivity(ctx) ? "activity" : run, role: "ink" }],
		[{ text: child, role: "ink" }],
	];
}

/** A crumb: a key, with its summary after it when one is given. */
export const crumb = (key: string, summary?: string): Line =>
	summary
		? [{ text: key, role: "ink" }, sp(2), { text: summary, role: "ink" }]
		: [{ text: key, role: "ink" }];

export const home = (ctx: Ctx) => ctx.models.home;

/** Where a run's things live on the web, or undefined when the view cannot tell. */
export function webOf(ctx: Ctx, run: string) {
	const repo = ctx.models.repos?.[run];
	const gh = repo && /^https:\/\/github\.com\//.test(repo) ? repo : undefined;
	const jira = ctx.models.jira?.replace(/\/+$/, "");
	return {
		pr: (n?: number) => (gh && n !== undefined ? `${gh}/pull/${n}` : undefined),
		branch: (b?: string) => (gh && b ? `${gh}/tree/${b}` : undefined),
		/** `GH-42` is the repository's issue 42; any other key is Jira's. */
		issue: (key: string) => {
			const m = /^GH-(\d+)$/.exec(key);
			if (m) return gh ? `${gh}/issues/${m[1]}` : undefined;
			return jira ? `${jira}/browse/${key}` : undefined;
		},
	};
}

/** The spans with `url` on each, or as they were without one. */
export const linked = (spans: Span[], url?: string): Span[] =>
	url ? spans.map((s) => (s.text.trim() ? { ...s, link: url } : s)) : spans;

/** A path with the home directory written as ~. */
export function tilde(path: string): string {
	const h = homedir();
	return h && path.startsWith(h) ? `~${path.slice(h.length)}` : path;
}

/** A path in at most w cells, shortened in the middle: `~/…/portia-home`. */
export function shortPath(path: string, w: number, unicode = true): string {
	if (strWidth(path) <= w) return path;
	// In ASCII the ellipsis paints as "~", which would read as a home directory.
	const cut = unicode ? "…" : "...";
	const parts = path.split("/");
	const last = parts.at(-1) ?? path;
	const head = parts[0] === "" ? "" : (parts[0] ?? "");
	for (const lead of [`${head}/${cut}/`, `${cut}/`]) {
		const s = `${lead}${last}`;
		if (strWidth(s) <= w) return s;
	}
	return cutLeft(path, w, cut);
}

/**
 * How long ago a run started. It ticks only while the run has a child working, or while
 * the seconds still show: otherwise it moves on the minute, which the header clock
 * already repaints for, so a run at rest costs no timer.
 */
export function startedAgo(ctx: Ctx, r: RunView): string {
	if (!r.startedAt) return "";
	const ms = ctx.tick.now - Date.parse(r.startedAt);
	const live = r.children.some(
		(c) => c.state === "running" && c.phase !== "quiet",
	);
	return live || ms < 3_600_000 ? ticking(ctx, ms, false) : clock(ms, false);
}

/** A running clock: it ticks every second, so the frame must repaint every second. */
export function ticking(
	ctx: Ctx,
	ms: number | undefined,
	narrow = ctx.narrow,
): string {
	if (ms === undefined || Number.isNaN(ms)) return "";
	ctx.flags.seconds = true;
	return clock(ms, narrow);
}

/** The characters of `key summary` that the filter's plain words matched. */
export function filterMarks(
	ctx: Ctx,
	key: string,
	summary: string,
): { key: Set<number>; summary: Set<number> } {
	const out = { key: new Set<number>(), summary: new Set<number>() };
	if (!ctx.state.filter?.text) return out;
	for (const t of parseFilter(ctx.state.filter.text))
		if (t.kind === "text")
			for (const i of subsequence(`${key} ${summary}`, t.value) ?? [])
				if (i < key.length) out.key.add(i);
				else if (i > key.length) out.summary.add(i - key.length - 1);
	return out;
}

/** Text cut and padded to w cells, with the marked characters underlined. */
export function underlined(
	text: string,
	w: number,
	marks: Set<number>,
	span: Partial<Span>,
): Span[] {
	const t = cut(text, w);
	const out: Span[] = [];
	[...t].forEach((ch, i) => {
		const u = marks.has(i);
		const last = out.at(-1);
		if (last && !!last.underline === u) last.text += ch;
		else out.push({ ...span, text: ch, underline: u || span.underline });
	});
	const gap = w - strWidth(t);
	if (gap > 0) out.push(sp(gap));
	return out;
}

// Text wraps the same way every frame: wrapping thousands of folds per spinner tick is
// most of what a long child costs.
const wrapped = new Map<string, string[]>();
function wrapOnce(text: string, w: number): string[] {
	const key = `${w}\u0000${text}`;
	let hit = wrapped.get(key);
	if (!hit) {
		hit = wrap(text, w).filter(
			(l, i, all) => l.trim() || (i > 0 && all[i - 1]?.trim()),
		);
		if (wrapped.size > 2000) wrapped.clear();
		wrapped.set(key, hit);
	}
	return hit;
}

/** Text as a pull quote at column `at`: `▎ text`, wrapped, `n` lines and a fold mark when cut. */
export function quote(
	ctx: Ctx,
	text: string,
	at: number,
	n: number,
	bar: Role,
	o: { role?: Role; italic?: boolean } = {},
): Line[] {
	const w = Math.max(10, ctx.W - at - 4);
	const lines = wrapOnce(text, w);
	const shown = lines.slice(0, n);
	const cut = lines.length > shown.length;
	// A cut quote never ends on the blank between two paragraphs.
	while (cut && shown.length > 1 && !shown.at(-1)?.trim()) shown.pop();
	return shown.map((l, i): Line => {
		const line: Line = [
			sp(at),
			{ text: ctx.g.quote, role: bar },
			sp(1),
			{ text: l, role: o.role ?? "ink2", italic: o.italic ?? true },
		];
		return cut && i === shown.length - 1
			? lr(line, [{ text: ctx.g.fold, role: "dim" }], ctx.W)
			: line;
	});
}
