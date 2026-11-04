import { hhmm, tokens } from "../../model/format";
import { shortStep } from "../../model/gates";
import { waveProgress } from "../../model/progress";
import type {
	ChildView,
	GateRun,
	RunView,
	StripCell,
	WaveView,
} from "../../model/types";
import {
	attentionChild,
	gateChildren,
	runChildren,
	selectedId,
} from "../../select";
import {
	ageOf,
	type Ctx,
	childGlyph,
	filterMarks,
	indent,
	linked,
	rule,
	STATE_ROLE,
	selected,
	underlined,
	waitHead,
	webOf,
} from "../common";
import {
	BAR_MAX,
	BAR_MIN,
	elapsedText,
	progressFigures,
	type StatCols,
	statsLine,
	statsWidth,
	statWidths,
} from "../progress";
import {
	cell,
	type Line,
	lineWidth,
	pad,
	type Span,
	sp,
	strWidth,
	truncate,
} from "../text";

import { reqFit, settled } from "./reqs";

export { shortStep };

export function phaseWord(c: ChildView): string {
	if (c.state === "running") return c.phase ?? "working";
	return c.state === "done" ? "landing" : c.state;
}

export function cellSpan(ctx: Ctx, c: StripCell): Span {
	const text = ctx.g.cell[c.kind];
	switch (c.kind) {
		case "pass":
			return { text, role: "done" };
		case "fail":
			return { text, role: "failed" };
		case "active":
			if (ctx.ink.motion) ctx.flags.animating = true;
			return { text, role: "running" };
		case "gap":
			return { text };
		default:
			return { text, role: "faint" };
	}
}

/** The columns every wave header and child row share, so the figures read down the screen. */
export interface RunCols {
	K: number;
	/** The gate strip; none below 100 columns. */
	G: number;
	/** A child's summary. */
	S: number;
	/** The wave labels' width, so every wave's bar starts in one column. */
	L: number;
	/** The wave bars. */
	B: number;
	/** The account column, when the run's workers rotate over accounts; none below 100 columns. */
	A: number;
	/** The column the figures start in, on child rows and wave headers alike. */
	X: number;
	st: StatCols;
	/** A `[Tag] ` every child's summary starts with, left off the rows; the epic carries it. */
	tag: string;
}

/** The `[Tag] ` every child's summary shares, or "" when any child's differs. */
export function sharedTag(r: RunView): string {
	const first = /^\[[^\]]+\]\s+/.exec(r.children[0]?.summary ?? "")?.[0];
	if (!first || r.children.length < 2) return "";
	return r.children.every((c) => c.summary.startsWith(first)) ? first : "";
}

const shown = (c: ChildView, tag: string) =>
	tag ? c.summary.slice(tag.length) : c.summary;

/** What a wave header says after its bar: who is running, or that it waits. */
function waveSuffix(w: WaveView): Span[] {
	// A quiet child is counted as quiet, in the dim its own row uses.
	const quiet = w.children.filter(
		(c) => c.state === "running" && c.phase === "quiet",
	).length;
	const active = w.running - quiet;
	if (w.running)
		return [
			...(active
				? [{ text: `${active} running`, role: "running" as const }]
				: []),
			...(quiet
				? [
						{
							text: `${active ? " · " : ""}${quiet} quiet`,
							role: "dim" as const,
						},
					]
				: []),
		];
	if (w.children.some((c) => c.state === "ready"))
		return [{ text: "ready", role: "dim" }];
	if (w.children.some((c) => c.state === "pending"))
		return [{ text: "pending", role: "dim" }];
	return [];
}

const SUFFIX_W = 18;

function childFigures(
	ctx: Ctx,
	c: ChildView,
): { n: string; d?: string; t?: string } {
	if (c.state === "ready" || c.state === "pending") return { n: "" };
	return {
		n: c.attempt
			? ctx.narrow
				? `try ${c.attempt}`
				: `attempt ${c.attempt}`
			: "",
		d: elapsedText(
			ctx,
			c.elapsedMs,
			c.state === "running" && c.phase !== "quiet",
		),
		t: c.tokens
			? `${tokens(c.tokens)}${c.tokensCounting ? "+" : ""}`
			: undefined,
	};
}

/**
 * Sized from every wave and child of the run, so the columns hold still while a filter
 * narrows the list. The figures end at the right edge. Short of room, the word "tokens"
 * goes, then the wave bars shrink to 8 cells, then the summaries are cut to 12, then the
 * tokens go and the summaries take their room back.
 */
export function runColumns(ctx: Ctx, r: RunView): RunCols {
	const now = ctx.tick.now;
	const K = Math.max(8, ...r.children.map((c) => c.key.length));
	const G = ctx.narrow
		? 0
		: r.catalog.task.length + r.catalog.exit.length
			? Math.min(15, r.catalog.task.length + 1 + r.catalog.exit.length)
			: 0;
	const figs = [
		...r.waves.map((w) => progressFigures(ctx, waveProgress(w, now))),
		...r.children.map((c) => childFigures(ctx, c)),
	];
	const st: StatCols = { ...statWidths(figs), tok: true, word: false };
	const tag = sharedTag(r);
	const SW = Math.max(
		4,
		...r.children.map((c) => strWidth(shown(c, tag) || "—")),
	);
	const accounts = r.children.flatMap((c) =>
		c.worker?.account ? [c.worker.account] : [],
	);
	const A =
		ctx.narrow || !accounts.length
			? 0
			: Math.min(12, Math.max(...accounts.map((a) => strWidth(a))));
	const L = Math.max(1, ...r.waves.map((w) => strWidth(w.label)));
	// Glyph, key and phase, and on wide screens the gates, the PR and the model.
	const fixed = ctx.narrow
		? 2 + 1 + 1 + K + 2 + 2 + 10 + 2
		: 4 +
			1 +
			1 +
			K +
			2 +
			2 +
			10 +
			2 +
			(G ? G + 2 : 0) +
			5 +
			2 +
			6 +
			(A ? 2 + A : 0) +
			3;
	const at = indent(ctx);
	const W = ctx.W;
	const room = () => W - fixed - statsWidth(st);
	let S = Math.min(SW, room());
	if (S < Math.min(SW, 12)) {
		st.tok = false;
		S = Math.min(SW, room());
	}
	S = Math.max(4, S);
	const X = fixed + S;
	// The bar leaves room for what the wave is doing before the figures.
	const B = Math.max(
		BAR_MIN,
		Math.min(BAR_MAX, X - 2 - (at + L + 2 + 2 + SUFFIX_W)),
	);
	return { K, G, S, L, B, X, st, A, tag };
}

/**
 * A wave as a quiet row over its children: its label, who is running, then the
 * figures. No bar: the map over the list shows the run's shape, and `landed/total`
 * says how far each wave has got.
 */
export function waveHeader(ctx: Ctx, w: WaveView, c: RunCols): Line {
	const at = indent(ctx);
	const p = waveProgress(w, ctx.tick.now);
	const head: Line = [sp(at), ...cell(w.label, c.L, "dim"), sp(2)];
	const stats = statsLine(c.st, progressFigures(ctx, p));
	const room = c.X - lineWidth(head) - 2;
	return [
		...head,
		...pad(truncate(waveSuffix(w), Math.max(0, room)), Math.max(0, room)),
		sp(2),
		...stats,
	];
}

function gates(ctx: Ctx, c: ChildView, G: number): Line {
	return c.strip.slice(0, G).map((x) => cellSpan(ctx, x));
}

/** A child: glyph, key, summary, phase, (gates, PR, model,) then `attempt · elapsed · ↓ tokens`. */
export function childRow(
	ctx: Ctx,
	r: RunView,
	c: ChildView,
	cols: RunCols,
	isSel: boolean,
): Line {
	const { K, G, S } = cols;
	const text = shown(c, cols.tag);
	const marks = filterMarks(ctx, c.key, text);
	const key = linked(
		underlined(c.key, K, marks.key, {
			role: STATE_ROLE[c.state],
			bold: isSel,
		}),
		webOf(ctx, r.key).issue(c.key),
	);
	const summary: Span[] = text
		? underlined(text, S, marks.summary, {
				// The row reads in its state's colour: green once landed, and so on.
				role: STATE_ROLE[c.state],
				strike: c.state === "closed",
			})
		: cell("—", S, "dim");
	const phase = phaseWord(c);
	const phaseRole =
		c.state === "running"
			? c.phase === "quiet"
				? "dim"
				: "running"
			: STATE_ROLE[c.state];
	const head: Line = [
		sp(ctx.narrow ? 2 : 4),
		childGlyph(ctx, c),
		sp(1),
		...key,
		sp(2),
		...summary,
		sp(2),
		...cell(phase, 10, phaseRole),
	];
	if (c.state === "pending" || c.state === "ready") {
		const open = (c.needs ?? []).filter(
			(n) => n.state !== "landed" && n.state !== "closed",
		);
		return open.length && r.source === "plan" && !ctx.narrow
			? [
					...head,
					sp(2),
					{ text: `needs ${open.map((n) => n.key).join(", ")}`, role: "dim" },
				]
			: head;
	}
	const stats = statsLine(cols.st, {
		...childFigures(ctx, c),
		nRole: c.attempt > 1 ? "ink2" : "dim",
	});
	if (ctx.narrow) return [...head, sp(2), ...stats];
	return [
		...head,
		sp(2),
		...(G
			? [
					...gates(ctx, c, G),
					sp(Math.max(0, G - Math.min(G, c.strip.length))),
					sp(2),
				]
			: []),
		...(c.pr
			? linked(cell(`#${c.pr}`, 5, "accent"), webOf(ctx, r.key).pr(c.pr))
			: cell("", 5)),
		sp(2),
		...cell(c.model?.requested ?? "", 6, "dim"),
		...(cols.A ? [sp(2), ...cell(c.worker?.account ?? "", cols.A, "dim")] : []),
		sp(3),
		...stats,
	];
}

/** The list's column names, over the same cells as a child's row, quiet and upper case. */
export function columnHead(ctx: Ctx, cols: RunCols): Line {
	const { K, G, S } = cols;
	const name = (t: string, w: number) => cell(t, w, "dim");
	const head: Line = [
		sp((ctx.narrow ? 2 : 4) + 2),
		...name("KEY", K),
		sp(2),
		...name("SUMMARY", S),
		sp(2),
		...name("PHASE", 10),
	];
	const stats = statsLine(cols.st, {
		n: "",
		d: "TIME",
		t: cols.st.tok ? "TOK" : undefined,
		nRole: "dim",
	}).map((x) => ({ ...x, role: "dim" as const }));
	if (ctx.narrow) return [...head, sp(2), ...stats];
	return [
		...head,
		sp(2),
		...(G ? [...name("GATES", G), sp(2)] : []),
		...name("PR", 5),
		sp(2),
		...name("MODEL", 6),
		...(cols.A ? [sp(2), ...name("ACCOUNT", cols.A)] : []),
		sp(3),
		...stats,
	];
}

/**
 * Under a parked child's row, in line with the summaries: why it waits and for how long,
 * then the start of its question.
 */
export function waitLine(
	ctx: Ctx,
	c: ChildView,
	cols: RunCols,
): Line | undefined {
	const head = waitHead(ctx, c);
	if (!head) return undefined;
	const first =
		c.wait?.kind === "question" ? (c.wait.text.split("\n")[0] ?? "") : "";
	return truncate(
		[
			sp((ctx.narrow ? 2 : 4) + 1 + 1 + cols.K + 2),
			head,
			...(first
				? [sp(2), { text: first, role: "ink2" as const, italic: true }]
				: []),
		],
		ctx.W,
	);
}

export function epicLine(ctx: Ctx, r: RunView, labelW: number): Line {
	const at = indent(ctx);
	const last = r.epicGates.at(-1);
	const lbl: Span = { text: "epic gate".padEnd(labelW), role: "dim" };
	if (!last)
		return [
			sp(at),
			lbl,
			{
				text: ctx.narrow
					? "not run yet"
					: "not run yet · runs once every child has landed",
				role: "dim",
			},
		];
	const g = ctx.g;
	const failed = last.steps.find((s) => s.ok === false)?.name;
	return [
		sp(at),
		lbl,
		{ text: g.event.epic, role: last.pass ? "accent" : "failed" },
		sp(1),
		{
			text: last.pass ? g.check : g.cross,
			role: last.pass ? "done" : "failed",
		},
		{
			text: last.pass
				? ` ${last.steps.length} steps · ${hhmm(last.at)}`
				: ` at ${failed ?? "?"} · try ${r.epicGates.length}`,
			role: "ink2",
		},
	];
}

export function childrenBody(
	ctx: Ctx,
	r: RunView,
): { lines: Line[]; sel?: number; items: number[] } {
	const kids = runChildren(r, ctx.state);
	const items: number[] = [];
	const sel = selectedId(
		ctx.state,
		`run:${r.key}:children`,
		kids.map((c) => c.key),
		attentionChild(
			r.children,
			kids.map((c) => c.key),
		),
	);
	const cols = runColumns(ctx, r);
	const lines: Line[] = [];
	let at: number | undefined;
	const shownWaves = r.waves.filter((w) =>
		w.children.some((c) => kids.includes(c)),
	);
	// One header names the columns; the waves follow with no gaps, so the list reads
	// as one table.
	if (kids.length) lines.push(columnHead(ctx, cols));
	for (const w of shownWaves) {
		const list = w.children.filter((c) => kids.includes(c));
		lines.push(waveHeader(ctx, w, cols));
		for (const c of list) {
			const isSel = c.key === sel;
			if (isSel) at = lines.length;
			const row = childRow(ctx, r, c, cols, isSel);
			items.push(lines.length);
			lines.push(isSel ? selected(ctx, row) : row);
			const why = waitLine(ctx, c, cols);
			if (why) lines.push(why);
		}
	}
	if (!kids.length)
		lines.push([
			sp(indent(ctx)),
			{
				text: r.children.length
					? "nothing matches the filter"
					: "not started · no children yet",
				role: "dim",
			},
		]);
	if (!ctx.narrow || r.epicGates.length) lines.push([], epicLine(ctx, r, 12));
	return { lines, sel: at, items };
}

/** The newest exit gate: the current attempt's, else the one before it. */
export function lastExit(
	c: ChildView,
): { gate: GateRun; attempt: number } | undefined {
	for (const a of [...c.attempts].reverse())
		if (a.exit) return { gate: a.exit, attempt: a.n };
	return undefined;
}

/**
 * A gate's steps with their marks: `typecheck ✓  lint ✓  unit ✗  integration ·`. In
 * `room` cells the steps that never ran go first, behind an ellipsis; only when the
 * steps that ran still do not fit are their names shortened.
 */
export function stepsLine(
	ctx: Ctx,
	g: GateRun,
	narrow: boolean,
	room = Number.POSITIVE_INFINITY,
): Line {
	const build = (steps: GateRun["steps"], short: boolean, more: boolean) => {
		const out: Line = [];
		steps.forEach((s, i) => {
			if (i) out.push(sp(narrow ? 1 : 2));
			out.push(
				{ text: short ? shortStep(s.name) : s.name, role: "ink2" },
				sp(1),
			);
			out.push(
				s.ok === true
					? { text: ctx.g.matrix.pass, role: "done" }
					: s.ok === false
						? { text: ctx.g.matrix.fail, role: "failed" }
						: { text: ctx.g.matrix.none, role: "faint" },
			);
		});
		if (more)
			out.push(sp(narrow ? 1 : 2), { text: ctx.g.ellipsis, role: "dim" });
		return out;
	};
	const full = build(g.steps, false, false);
	if (lineWidth(full) <= room) return full;
	const ran = g.steps.filter((s) => s.ok !== null);
	const cut = build(ran, false, ran.length < g.steps.length);
	if (lineWidth(cut) <= room) return cut;
	return build(ran, true, ran.length < g.steps.length);
}

/**
 * The selected child under the list: where it is, its last exit gate, what it proves and
 * its last message. One row each, the same rows for every child of the run, so moving
 * the cursor never moves the list.
 */
/** The child the Run page's cursor is on, in its list or its gate matrix. */
export function selectedChild(ctx: Ctx, r: RunView): ChildView | undefined {
	const kids = ctx.state.matrix
		? gateChildren(r, ctx.state)
		: runChildren(r, ctx.state);
	const sel = selectedId(
		ctx.state,
		`run:${r.key}:${ctx.state.matrix ? "gates" : "children"}`,
		kids.map((c) => c.key),
		attentionChild(
			r.children,
			kids.map((c) => c.key),
		),
	);
	return kids.find((x) => x.key === sel);
}

export function childrenDock(ctx: Ctx, r: RunView): Line[] {
	const c = selectedChild(ctx, r);
	const at = indent(ctx);
	const proves = r.children.some((x) => x.requirements.length);
	const lines: Line[] = proves ? [[], [], [], []] : [[], [], []];
	const msgAt = proves ? 3 : 2;
	if (c) {
		// The key leads at every width: the dock says which child it describes.
		const parts: string[] = [c.key];
		if (c.attempt)
			parts.push(ctx.narrow ? `try ${c.attempt}` : `attempt ${c.attempt}`);
		parts.push(
			c.state === "running"
				? `${phaseWord(c)} ${c.phaseSince ? ageOf(ctx, c.phaseSince) : ""}`.trim()
				: phaseWord(c),
		);
		if (c.model) parts.push(c.model.requested);
		if (c.worker?.account) parts.push(`account ${c.worker.account}`);
		if (c.env?.branch && !ctx.narrow) parts.push(c.env.branch);
		if (c.env?.port !== undefined) parts.push(`port ${c.env.port}`);
		if (c.pr) parts.push(`#${c.pr}`);
		const [first = "", ...rest] = parts;
		lines[0] = truncate(
			[
				sp(at),
				{ text: first, role: "ink" },
				{ text: rest.length ? ` · ${rest.join(" · ")}` : "", role: "ink2" },
			],
			ctx.W,
		);
		const exit = lastExit(c);
		const stale = (n: number) => n > 0 && n !== c.attempt;
		if (exit) {
			const lbl = ctx.narrow ? "last exit" : "last exit gate";
			const from = stale(exit.attempt)
				? ctx.narrow
					? ` · try ${exit.attempt}`
					: ` · attempt ${exit.attempt}`
				: "";
			const used = strWidth(lbl) + from.length;
			const gap = Math.max(ctx.narrow ? 2 : 3, (ctx.narrow ? 11 : 17) - used);
			lines[1] = truncate(
				[
					sp(at),
					{ text: lbl, role: "dim" },
					{ text: from, role: "dim" },
					sp(gap),
					...stepsLine(
						ctx,
						exit.gate,
						ctx.narrow,
						ctx.W - at - strWidth(lbl) - from.length - gap,
					),
				],
				ctx.W,
			);
		}
		const msg = c.lastMessage;
		// A message from an earlier attempt says so, and goes once the current
		// attempt has passed a gate since it was written.
		const old = msg ? stale(msg.attempt) : false;
		const superseded =
			msg &&
			old &&
			c.attempts.some(
				(a) =>
					a.n === c.attempt &&
					a.events.some(
						(e) =>
							e.row.stage === "gate" &&
							e.row.status === "pass" &&
							e.at > msg.at,
					),
			);
		if (proves && c.requirements.length) {
			const lbl = "proves";
			const gap = Math.max(
				ctx.narrow ? 2 : 3,
				(ctx.narrow ? 11 : 17) - lbl.length,
			);
			const fit = reqFit(
				ctx,
				c.requirements.map((q) => ({ id: q.id, ok: q.ok === true })),
				ctx.W - at - lbl.length - gap,
				settled(c.state),
			);
			const n = c.requirements.filter((q) => q.ok).length;
			// One requirement says what it is; several say how many are proven.
			const one = c.requirements.length === 1 ? c.requirements[0] : undefined;
			const tail: Span[] = one
				? [
						...(one.text
							? [sp(1), { text: one.text, role: "ink2" as const }]
							: []),
						{
							text: one.ok
								? ""
								: settled(c.state)
									? " · not proven"
									: " · not yet",
							role: "dim",
						},
					]
				: [
						{
							text: ctx.narrow
								? `  ${n} of ${c.requirements.length}`
								: `   ${n} of ${c.requirements.length} proven · → for the evidence`,
							role: "dim",
						},
					];
			lines[2] = truncate(
				[sp(at), { text: lbl, role: "dim" }, sp(gap), ...fit.spans, ...tail],
				ctx.W,
			);
		}
		if (msg && !superseded) {
			const head = msg.text.split("\n")[0] ?? "";
			lines[msgAt] = truncate(
				[
					sp(at),
					{ text: ctx.g.quote, role: msg.role },
					sp(1),
					...(old
						? [
								{
									text: ctx.narrow
										? `try ${msg.attempt} · `
										: `attempt ${msg.attempt} · `,
									role: "dim" as const,
								},
							]
						: []),
					{ text: head, role: "ink2", italic: true },
				],
				ctx.W,
			);
		}
	}
	return [rule(ctx), ...lines];
}
