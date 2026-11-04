import { tokens } from "../../model/format";
import { runProgress } from "../../model/progress";
import type { ChildView, RunView } from "../../model/types";
import { homeRuns, selectedId } from "../../select";
import {
	ageOf,
	breathFrame,
	type Ctx,
	childGlyph,
	clockNow,
	filterMarks,
	finialOf,
	header,
	hints,
	home,
	indent,
	label,
	linked,
	mark,
	marked,
	rule,
	STATE_ROLE,
	selected,
	shortPath,
	spin,
	startedAgo,
	ticking,
	tilde,
	underlined,
	webOf,
} from "../common";
import { compose } from "../frame";
import { HERO_ROWS, HERO_WIDTH, hero } from "../logo";
import {
	GRID_LABEL,
	machineBlock,
	machineStrip,
	machineTail,
} from "../machine";
import { footer } from "../overlays";
import {
	BAR_MAX,
	BAR_MID,
	BAR_MIN,
	progressBar,
	progressFigures,
	progressGlyph,
	runTone,
	type StatCols,
	statsLine,
	statsWidth,
	statWidths,
} from "../progress";
import {
	cell,
	type Line,
	lineWidth,
	lr,
	pad,
	rcell,
	type Span,
	sp,
	strWidth,
	truncate,
} from "../text";
import { phaseWord } from "./children";

export const GROUP_LABEL = {
	waiting: "WAITING ON YOU",
	session: "IN SESSION",
	judgement: "AWAITING JUDGEMENT",
	rest: "AT REST",
	delivered: "DELIVERED",
};

/**
 * One mark per child, wave by wave with a gap between waves, capped at T cells. Every mark
 * is one still cell, so the row sits level and only the rows under it move: a child that
 * has started is a solid mark in its state's colour, one ready an open mark, and one still
 * waiting its turn a dot.
 */
export function runStrip(ctx: Ctx, r: RunView, T: number): Line {
	const u = ctx.ink.unicode;
	const mark = (c: ChildView): Span => {
		if (c.state === "pending") return { text: u ? "·" : ".", role: "faint" };
		if (c.state === "ready") return { text: u ? "□" : "o", role: "dim" };
		return { text: u ? "■" : "#", role: STATE_ROLE[c.state] };
	};
	const cells: Span[] = [];
	let used = 0;
	let shown = 0;
	for (const [i, w] of r.waves.entries()) {
		if (i) {
			cells.push(sp(WAVE_GAP));
			used += WAVE_GAP;
		}
		for (const c of w.children) {
			if (used >= T - 3 && r.children.length - shown > 3) {
				cells.push({ text: `+${r.children.length - shown}`, role: "dim" });
				return cells;
			}
			cells.push(mark(c));
			used++;
			shown++;
		}
	}
	return cells;
}

const WAVE_GAP = 2;
const stripWidth = (r: RunView) =>
	r.children.length + WAVE_GAP * Math.max(0, r.waves.length - 1);

/**
 * The compact header's status cluster: the census, the tokens, the machine tail and the
 * clock, in `room` cells. What does not fit goes in this order: the tokens, then the
 * disk, the CPU and the memory figure; the census and the clock always stay.
 */
export function censusCompact(
	ctx: Ctx,
	room = Number.POSITIVE_INFINITY,
	withMachine = true,
): Line {
	return statusCluster(ctx, statusHead(ctx), room, !ctx.narrow, withMachine);
}

/** `⠹ 1 in session · ! 2 need you`, shortened below 100 columns, or `idle`. */
export function statusHead(ctx: Ctx): Line {
	const h = home(ctx);
	const head: Line = [];
	const sep = (): Span => ({ text: " · ", role: "dim" });
	if (h.inSession)
		head.push(
			spin(ctx, "census"),
			{ text: ` ${h.inSession}`, role: "running" },
			{ text: ctx.narrow ? " live" : " in session", role: "ink2" },
		);
	if (h.needYou) {
		if (head.length) head.push(sep());
		head.push({
			text: `! ${h.needYou}${ctx.narrow ? "" : " need you"}`,
			role: "parked",
			bold: true,
		});
	}
	if (!head.length) head.push({ text: "idle", role: "dim" });
	return head;
}

/**
 * `head · <tokens> tok · cpu · mem · disk · HH:MM` in `room` cells. What does not fit
 * goes in this order: the tokens, the disk, the CPU, then memory; the head and the
 * clock stay.
 */
export function statusCluster(
	ctx: Ctx,
	head: Line,
	room: number,
	withTokens: boolean,
	withMachine = true,
): Line {
	const sep = (): Span => ({ text: " · ", role: "dim" });
	// Parts in the order they show; `drop` is the order they go.
	const [mem, cpu, disk] = withMachine ? machineTail(ctx) : [];
	const parts: { line: Line; drop: number }[] = [
		...(withTokens
			? [
					{
						line: [
							{
								text: `${tokens(home(ctx).tokens)} tok`,
								role: "dim" as const,
							},
						],
						drop: 0,
					},
				]
			: []),
		...(cpu ? [{ line: cpu, drop: 2 }] : []),
		...(mem ? [{ line: mem, drop: 3 }] : []),
		...(disk ? [{ line: disk, drop: 1 }] : []),
	];
	const build = () => {
		const out: Line = [...head];
		for (const p of parts) out.push(sep(), ...p.line);
		out.push(sep(), { text: clockNow(ctx), role: "dim" });
		return out;
	};
	let out = build();
	while (lineWidth(out) > room && parts.length) {
		const i = parts.reduce(
			(b, p, j) => (p.drop < (parts[b]?.drop ?? 9) ? j : b),
			0,
		);
		parts.splice(i, 1);
		out = build();
	}
	return out;
}

/**
 * The census beside the hero, each line fitted to `room` cells. With `lab` cells to
 * spare it is a labelled grid, `runs`, `children` and `tokens`, in the same label
 * column as the machine's rows under it.
 */
function census(ctx: Ctx, room: number, beside = true, lab = 0): Line[] {
	const h = home(ctx);
	const session: Line = h.inSession
		? [
				spin(ctx, "census"),
				{ text: ` ${h.inSession}`, role: "running" },
				{ text: " in session", role: "ink2" },
			]
		: [];
	const need: Line = h.needYou
		? [{ text: `! ${h.needYou} need you`, role: "parked", bold: true }]
		: [];
	if (!lab) {
		// Beside the hero the groups stand apart; in one line they take the dot.
		const gap: Span = beside ? sp(4) : { text: " · ", role: "dim" };
		const l1: Line =
			session.length && need.length
				? [...session, gap, ...need]
				: [...session, ...need];
		return [
			l1.length ? l1 : [{ text: "idle", role: "dim" }],
			[
				{
					text: `${h.runningChildren} children running · ${h.landedThisWeek} landed this week`,
					role: "ink2",
				},
			],
			[{ text: censusTail(ctx, room), role: "dim" }],
		];
	}
	// In the grid, what needs you leads.
	const runs: Line =
		need.length && session.length
			? [...need, { text: " · ", role: "dim" }, ...session]
			: [...need, ...session];
	const head = (t: string): Span => ({ text: t.padEnd(lab), role: "dim" });
	return [
		[
			head("runs"),
			...(runs.length ? runs : [{ text: "idle", role: "dim" as const }]),
		],
		[
			head("children"),
			{
				text: `${h.runningChildren} running · ${h.landedThisWeek} landed this week`,
				role: "ink2",
			},
		],
		[head("tokens"), { text: censusTail(ctx, room - lab, false), role: "dim" }],
	];
}

/** `<tokens> tokens · <home> · HH:MM`: the path shortens, then goes, then the tokens; never the clock. */
function censusTail(ctx: Ctx, room: number, word = true): string {
	const h = home(ctx);
	const total = word ? `${tokens(h.tokens)} tokens` : tokens(h.tokens);
	const clock = clockNow(ctx);
	const where = tilde(h.home);
	const fixed = strWidth(`${total} ·  · ${clock}`);
	const path = shortPath(where, room - fixed, ctx.ink.unicode);
	if (room - fixed >= 8 && strWidth(path) <= room - fixed)
		return `${total} · ${path} · ${clock}`;
	if (strWidth(`${total} · ${clock}`) <= room) return `${total} · ${clock}`;
	return clock;
}

function eventSpans(r: RunView, w: number): Line {
	const text = r.lastEvent ?? "";
	const first = r.children.find((c) => text.startsWith(`${c.key} `));
	const spans: Line = first
		? [
				{ text: first.key, role: "ink2" },
				...marked(text.slice(first.key.length), "ink2"),
			]
		: marked(text, r.glyph === "empty" ? "dim" : "ink2");
	return truncate(spans, w);
}

interface Cols {
	K: number;
	S: number;
	/** The bar; it gives way first, down to `BAR_MIN`. */
	B: number;
	/** The quiet trailing column (epic PR and last event), only when there is room. */
	E: number;
	/** The gap either side of the bar. */
	gap: number;
	st: StatCols;
}

const LEAD = 2 + 1 + 1;

/**
 * One set of columns for every run, so the bars and figures line up across groups. Past
 * the reference layout (summary, a 20-cell bar, the figures) the rest of the row is the
 * epic PR and the last event. Short of it, the word "tokens" goes, then the summary is
 * cut to 24 cells, then the bar shrinks to 12, then the summary is cut to 12, then the
 * bar shrinks to 8, then the tokens go and the summary takes
 * their room back; a row never wraps.
 */
export function homeColumns(ctx: Ctx, runs: RunView[]): Cols {
	const K = Math.max(8, ...runs.map((r) => r.key.length));
	const SW = Math.max(1, ...runs.map(summaryWidth));
	const figs = runs.map((r) =>
		progressFigures(ctx, runProgress(r, ctx.tick.now)),
	);
	const st: StatCols = { ...statWidths(figs), tok: true, word: true };
	const gap = ctx.narrow ? 2 : 3;
	const W = ctx.W;
	let S = SW;
	let B = BAR_MAX;
	let E = 0;
	const used = () => LEAD + K + 2 + S + gap + B + gap + statsWidth(st);
	const trail = W - used() - 4;
	if (!ctx.narrow && trail >= 16) E = trail;
	else {
		if (used() > W) st.word = false;
		if (used() > W) S = Math.max(Math.min(SW, 24), S - (used() - W));
		if (used() > W) B = Math.max(BAR_MID, B - (used() - W));
		if (used() > W) S = Math.max(Math.min(SW, 12), S - (used() - W));
		if (used() > W) B = Math.max(BAR_MIN, B - (used() - W));
		if (used() > W) {
			st.tok = false;
			S = Math.min(SW, S + (W - used()));
		}
		if (used() > W) S = Math.max(4, S - (used() - W));
	}
	return { K, S, B, E, gap, st };
}

/** `1 question for you`, `3 questions for you`, or "" when none waits. */
export const questionsText = (n: number): string =>
	n ? `${n} ${n === 1 ? "question" : "questions"} for you` : "";

/** The summary cell's text width: the questions waiting lead, then the summary. */
const summaryWidth = (r: RunView) =>
	strWidth(
		[questionsText(r.questions), r.summary || (r.questions ? "" : "—")]
			.filter(Boolean)
			.join(" · "),
	);

function summarySpan(ctx: Ctx, r: RunView, w: number): Span[] {
	const asks = questionsText(r.questions);
	if (asks) {
		const lead: Line = [
			{ text: asks, role: "parked", bold: true },
			...(r.summary
				? [
						{ text: " · ", role: "dim" as const },
						{ text: r.summary, role: "ink" as const },
					]
				: []),
		];
		return pad(truncate(lead, w), w);
	}
	if (!r.summary) return cell("—", w, "dim");
	return underlined(r.summary, w, filterMarks(ctx, r.key, r.summary).summary, {
		role: "ink",
	});
}

/** `#412  ACME-505 task gate ✓ 3/3`, quiet, in w cells. */
function trailing(r: RunView, w: number): Line {
	const pr: Span[] = cell(r.epicPr ? `#${r.epicPr}` : "—", 5, "dim");
	return pad(
		truncate(
			[
				...pr,
				sp(2),
				...eventSpans(r, w).map((s) => ({ ...s, role: "dim" as const })),
			],
			w,
		),
		w,
	);
}

/** A run as one progress row: glyph, key, summary, bar, then `landed/total · elapsed · ↓ tokens`. */
function runRow(ctx: Ctx, r: RunView, c: Cols, isSel: boolean): Line {
	const keySpan = linked(
		underlined(r.key, c.K, filterMarks(ctx, r.key, r.summary ?? "").key, {
			role: "ink",
			bold: isSel,
		}),
		webOf(ctx, r.key).issue(r.key),
	);
	const p = runProgress(r, ctx.tick.now);
	return [
		sp(2),
		progressGlyph(ctx, r),
		sp(1),
		...keySpan,
		sp(2),
		...summarySpan(ctx, r, c.S),
		sp(c.gap),
		...progressBar(ctx, p.done, p.total, c.B, runTone(r)),
		sp(c.gap),
		...statsLine(c.st, progressFigures(ctx, p)),
		...(c.E ? [sp(4), ...trailing(r, c.E)] : []),
	];
}

const DOCK_ORDER = ["running", "parked", "failed", "ready"];
/** The list's key column: the dock's key and marks start here, a child's glyph two before. */
const DOCK_AT = 4;

function dockChildren(r: RunView): ChildView[] {
	return DOCK_ORDER.flatMap((s) =>
		r.children.filter((c) => c.state === s),
	).slice(0, 3);
}

/**
 * The selected run, on the list's own columns: its key and summary with the epic PR and
 * branch; its children as one mark each with the counts; then the children still in play.
 */
function dock(ctx: Ctx, r: RunView | undefined, listK: number): Line[] {
	if (!r || ctx.size.rows < 24) return [];
	const kids = dockChildren(r);
	const K = Math.max(listK, ...kids.map((c) => c.key.length));
	const web = webOf(ctx, r.key);
	const where: Line = [
		...(r.epicPr
			? [
					...linked(
						[{ text: `#${r.epicPr}`, role: "accent" as const }],
						web.pr(r.epicPr),
					),
					...(r.branch ? [{ text: " · ", role: "dim" as const }] : []),
				]
			: []),
		...(r.branch ? [{ text: r.branch, role: "dim" as const }] : []),
	];
	const head = lr(
		[
			sp(DOCK_AT),
			...linked([{ text: r.key.padEnd(K), role: "ink" }], web.issue(r.key)),
			...(r.summary ? [sp(2), { text: r.summary, role: "ink2" as const }] : []),
		],
		where,
		ctx.W,
	);
	const landed = r.children.filter((c) => c.state === "landed").length;
	const working = r.children.filter((c) => c.state === "running").length;
	const counts: Line = r.children.length
		? [
				{
					text: `${landed} of ${r.children.length} landed`,
					role: "dim",
				},
				...(working
					? [{ text: ` · ${working} working`, role: "dim" as const }]
					: []),
				...(r.questions
					? [
							{ text: " · ", role: "dim" as const },
							{ text: questionsText(r.questions), role: "parked" as const },
						]
					: []),
			]
		: [];
	const about: Line[] = r.children.length
		? [
				lr(
					[
						sp(DOCK_AT),
						...runStrip(
							ctx,
							r,
							Math.min(stripWidth(r), ctx.W - DOCK_AT - lineWidth(counts) - 3),
						),
					],
					counts,
					ctx.W,
				),
			]
		: [];
	const lines = kids.map(
		(c): Line => [
			sp(DOCK_AT - 2),
			childGlyph(ctx, c),
			sp(1),
			{ text: c.key.padEnd(K), role: "ink" },
			sp(2),
			...cell(phaseWord(c), 10, "ink2"),
			...rcell(
				c.state === "running" ? ticking(ctx, c.elapsedMs) : "",
				8,
				"ink2",
			),
			sp(2),
			{ text: c.summary || "—", role: c.summary ? "ink2" : "dim" },
		],
	);
	return [rule(ctx), head, ...about, ...(lines.length ? [[], ...lines] : [])];
}

function runsBody(
	ctx: Ctx,
	runs: RunView[],
	sel?: string,
): { lines: Line[]; sel?: number; items: number[] } {
	// Sized from every run, so the columns hold still while a filter narrows the list.
	const c = homeColumns(ctx, home(ctx).runs);
	const lines: Line[] = [];
	const items: number[] = [];
	let at: number | undefined;
	let last: string | undefined;
	for (const r of runs) {
		if (r.group !== last) {
			if (last !== undefined) lines.push([]);
			lines.push(
				label(
					ctx,
					GROUP_LABEL[r.group],
					runs.filter((x) => x.group === r.group).length,
				),
			);
			last = r.group;
		}
		const isSel = r.key === sel;
		const row = runRow(ctx, r, c, isSel);
		if (isSel) at = lines.length;
		items.push(lines.length);
		lines.push(isSel ? selected(ctx, row) : row);
	}
	return { lines, sel: at, items };
}

export function matchRight(ctx: Ctx, m: number, n: number, what: string): Line {
	return ctx.state.filter?.text
		? [{ text: `${m} of ${n} ${what} match`, role: "accent" }]
		: [];
}

/** The line under the header: a filter's match count, or a sort that is not the default. */
function subhead(ctx: Ctx, left: Line, m: number, n: number): Line {
	const right = ctx.state.filter?.text
		? matchRight(ctx, m, n, "runs")
		: ctx.state.sort !== "activity"
			? [{ text: `sort: ${ctx.state.sort}`, role: "dim" as const }]
			: [];
	return lr([sp(indent(ctx)), ...left], right, ctx.W);
}

export const HOME_HINTS = (waiting: boolean): string[] => [
	"↑↓ move",
	"→ open",
	waiting ? "Q answer" : "",
	"a activity",
	"/ filter",
	"n new",
	"? help",
	"q quit",
];

/** Body rows the hero leaves at the least; short of them it gives way to the strip. */
const HERO_MIN_BODY = 8;
/** The dock at its tallest: the rule, its two lines, a gap and three children. */
const DOCK_MAX = 7;
/** The machine strip under the compact header needs this many rows. */
const STRIP_MIN_ROWS = 20;

export function homeScreen(ctx: Ctx): Line[] {
	const h = home(ctx);
	if (!h.runs.length) return emptyHome(ctx);
	const runs = homeRuns(h, ctx.state);
	const left = mark(ctx, ctx.narrow ? "narrow" : "wide");
	const strip =
		ctx.size.rows >= STRIP_MIN_ROWS
			? machineStrip(ctx, ctx.W - indent(ctx) - 2)
			: [];
	const compactHeader = header(
		ctx,
		left,
		censusCompact(ctx, ctx.W - 1 - lineWidth(left) - 2, !strip.length),
	);
	const sel = selectedId(
		ctx.state,
		"home:runs",
		runs.map((r) => r.key),
	);
	const selRun = runs.find((r) => r.key === sel);
	const body = runsBody(ctx, runs, sel);
	const d = dock(ctx, selRun, Math.max(8, ...h.runs.map((r) => r.key.length)));
	const foot = footer(
		ctx,
		hints(ctx, HOME_HINTS(h.runs.some((r) => r.questions > 0))),
		{
			m: runs.length,
			n: h.runs.length,
		},
	);
	// The hero stays while the list keeps a useful window, scrolling under it; the
	// tallest dock counts, so moving the selection never takes the hero away.
	// Beside the hero the machine keeps six cells from the word; when its graphics do not
	// fit there, the strip goes under the hero instead of figures without them.
	const graphicMach = machineBlock(ctx, ctx.W - 3 - HERO_WIDTH - 6, true);
	const stripUnder = !graphicMach.length && strip.length > 0;
	const heroFits =
		ctx.size.cols >= HERO_WIDTH + 6 &&
		ctx.size.rows -
			(HERO_ROWS + 3 + (stripUnder ? 1 : 0)) -
			(ctx.size.rows < 24 ? 0 : DOCK_MAX) -
			2 >=
			HERO_MIN_BODY;
	if (heroFits) {
		const art = hero(ctx.ink, {
			finial: finialOf(ctx),
			breath: breathFrame(ctx),
			scales: ctx.tick.arrival?.scales,
			gild: ctx.tick.arrival?.gild,
		});
		if (ctx.tick.arrival) ctx.flags.animating = true;
		const room = ctx.W - 3 - HERO_WIDTH - 2;
		// The census needs 36 cells beside the hero, and its labels 9 more.
		const beside = room >= 36;
		const lab = room >= 36 + GRID_LABEL ? GRID_LABEL : 0;
		const cen = census(ctx, room, beside, lab);
		const mach = graphicMach.length
			? graphicMach
			: stripUnder
				? []
				: machineBlock(ctx, ctx.W - 3 - HERO_WIDTH - 6);
		// Too narrow for the census beside the hero: its first line goes under the hero,
		// with the clock, and with the machine's figures when there is no room for them
		// beside the hero or in the strip either.
		const under: Line =
			beside || ctx.state.filter?.text
				? []
				: mach.length || stripUnder
					? [...(cen[0] ?? []), { text: ` · ${clockNow(ctx)}`, role: "dim" }]
					: statusCluster(
							ctx,
							ctx.narrow ? statusHead(ctx) : (cen[0] ?? []),
							ctx.W - indent(ctx) - 2,
							false,
						);
		// Beside the hero, from the top of the word: the census on rows 1–3, set flush
		// right (§9.1), and the machine on rows 5–8, down to the epigraph; without the
		// census the machine starts at the top. The machine's lines are all one width,
		// so the block's left edge holds still as its figures change.
		const fits = cen.map((c) => beside && lineWidth(c) <= room);
		const right = new Map<number, Line>();
		cen.forEach((c, i) => {
			if (fits[i]) right.set(1 + i, c);
		});
		const from = right.size ? 5 : 1;
		mach.forEach((l, i) => {
			right.set(from + i, l);
		});
		// As a grid, census and machine share one left edge: each row is padded to the
		// widest, so the labels read down as one column.
		if (lab) {
			const w = Math.max(...[...right.values()].map(lineWidth));
			for (const [i, l] of right) right.set(i, pad(l, w));
		}
		const top: Line[] = [
			[],
			...art.map((row, i) => {
				const line: Line = [sp(3), ...row];
				const c = right.get(i);
				return c ? lr(line, c, ctx.W) : line;
			}),
			[],
			...(stripUnder ? [[sp(indent(ctx)), ...strip]] : []),
			subhead(ctx, under, runs.length, h.runs.length),
		];
		return compose(ctx, {
			top,
			body: body.lines,
			sel: body.sel,
			items: body.items,
			scrollKey: "home:runs",
			dock: d,
			footer: foot,
		});
	}
	return compose(ctx, {
		top: [
			compactHeader,
			...(strip.length ? [[sp(indent(ctx)), ...strip]] : []),
			rule(ctx),
			subhead(ctx, [], runs.length, h.runs.length),
		],
		body: body.lines,
		sel: body.sel,
		items: body.items,
		scrollKey: "home:runs",
		dock: d,
		footer: foot,
	});
}

const EMPTY = (home: string) => [
	`No runs yet in ${home}. Start one with n, or /portia <KEY> in Claude Code;`,
	"this screen lights up as it works.",
];

function emptyHome(ctx: Ctx): Line[] {
	const h = home(ctx);
	const where = tilde(h.home);
	const foot = footer(
		ctx,
		hints(ctx, ["n new run", "? help", "q quit"], false),
	);
	if (ctx.size.cols < HERO_WIDTH + 6) {
		const msg = [
			`No runs yet in ${where}.`,
			"Start one with n, or /portia <KEY> in Claude Code;",
			"this screen lights up as it works.",
		];
		const top = [
			header(ctx, mark(ctx, "narrow"), [{ text: clockNow(ctx), role: "dim" }]),
			rule(ctx),
		];
		const pad = Math.max(
			0,
			Math.floor((ctx.size.rows - 2 - 2 - msg.length) / 2),
		);
		const body: Line[] = [
			...Array.from({ length: pad }, () => []),
			...msg.map((m): Line => [sp(2), { text: m, role: "ink2" }]),
		];
		return compose(ctx, { top, body, footer: foot });
	}
	const art = hero(ctx.ink, {
		finial: "idle",
		breath: breathFrame(ctx),
		scales: ctx.tick.arrival?.scales,
		gild: ctx.tick.arrival?.gild,
	});
	const off = Math.max(0, Math.floor((ctx.size.cols - HERO_WIDTH) / 2));
	const msg = EMPTY(where);
	const used = HERO_ROWS + 1 + msg.length;
	const block = machineBlock(ctx, ctx.size.cols - off - 2);
	const mach =
		used + 1 + block.length + 2 <= ctx.size.rows ? [[], ...block] : [];
	const top = Math.max(
		0,
		Math.floor((ctx.size.rows - used - mach.length - 2) / 2),
	);
	const body: Line[] = [
		...Array.from({ length: top }, () => []),
		...art.map((row) => [sp(off), ...row]),
		[],
		...msg.map((m): Line => [sp(off), { text: m, role: "ink2" }]),
		...mach.map((l): Line => (l.length ? [sp(off), ...l] : l)),
	];
	return compose(ctx, { top: [], body, footer: foot });
}
