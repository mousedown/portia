import {
	age,
	clock,
	hhmm,
	isToday,
	monthDay,
	tokens,
} from "../../model/format";
import type {
	Attempt,
	ChildView,
	Event,
	Role,
	RunView,
} from "../../model/types";
import type { LogKind, LogLine } from "../../model/worker";
import {
	attemptItem,
	attemptOpen,
	childItems,
	evItem,
	evidenceIds,
	failureText,
	gateItem,
	phaseItem,
	selectedId,
	shownGates,
	workerItem,
	worktreeOf,
} from "../../select";
import {
	type Ctx,
	childCrumbs,
	childGlyph,
	clockNow,
	hints,
	indent,
	label,
	linked,
	marked,
	pageHeader,
	quote,
	rule,
	STATE_ROLE,
	selected,
	spin,
	ticking,
	tilde,
	waitHead,
	webOf,
} from "../common";
import { compose, type Lazy } from "../frame";
import { GRID_LABEL } from "../machine";
import { footer } from "../overlays";
import {
	asHead,
	cell,
	type Line,
	lr,
	type Span,
	sp,
	strWidth,
	truncate,
} from "../text";
import { detailFor } from "./activity";
import { phaseWord, stepsLine } from "./children";
import { approvalRow, filesSummary, globWidth } from "./files";
import { settled } from "./reqs";

const OUTCOME_ROLE = {
	done: "done",
	parked: "parked",
	failed: "failed",
	landed: "landed",
	"land failed": "failed",
	running: "running",
} as const;

function outcomeGlyph(ctx: Ctx, c: ChildView, a: Attempt): Span {
	const g = ctx.g.state;
	switch (a.outcome) {
		case "running":
			return c.phase === "quiet"
				? { text: g.running, role: "dim" }
				: spin(ctx, c.key);
		case "landed":
			return { text: g.landed, role: "landed", bold: true };
		case "done":
			return { text: g.done, role: "done" };
		case "parked":
			return { text: g.parked, role: "parked" };
		case "failed":
		case "land failed":
			return { text: g.failed, role: "failed" };
		default:
			return { text: g.pending, role: "dim" };
	}
}

function attemptTitle(ctx: Ctx, c: ChildView, a: Attempt, open: boolean): Line {
	const at = indent(ctx);
	const dur =
		a.outcome === "running"
			? ticking(ctx, ctx.tick.now - Date.parse(a.startedAt))
			: a.endedAt
				? clock(Date.parse(a.endedAt) - Date.parse(a.startedAt), ctx.narrow)
				: "";
	const quiet = a.outcome === "running" && c.phase === "quiet";
	const parts = [
		quiet ? "quiet" : (a.outcome ?? "ended"),
		dur,
		a.tokens
			? ctx.narrow
				? tokens(a.tokens)
				: `${tokens(a.tokens)} tokens`
			: "",
		// Event times carry no date: an attempt from another day says which.
		a.startedAt && !isToday(a.startedAt, ctx.tick.now)
			? monthDay(a.startedAt, false)
			: "",
		open ? "" : `${a.events.length} row${a.events.length === 1 ? "" : "s"}`,
	].filter(Boolean);
	const left: Line = [
		sp(at),
		{ text: String(a.n), role: "ink" },
		sp(2),
		outcomeGlyph(ctx, c, a),
		sp(1),
		{
			text: parts.join(" · "),
			role: quiet ? "dim" : a.outcome ? OUTCOME_ROLE[a.outcome] : "dim",
		},
		sp(2),
	];
	const w = left.reduce((n, s) => n + strWidth(s.text), 0);
	// A closed attempt ends in the fold mark: ⏎ opens it.
	const tail = open ? 0 : 2;
	return [
		...left,
		{ text: ctx.g.rule.repeat(Math.max(0, ctx.W - w - tail)), role: "rule" },
		...(open ? [] : [sp(1), { text: ctx.g.fold, role: "dim" as const }]),
	];
}

interface Cols {
	time: number;
	lead: number;
	label: number;
	detailAt: number;
}
const cols = (ctx: Ctx): Cols =>
	ctx.narrow
		? { time: 5, lead: 4, label: 12, detailAt: 4 + 5 + 2 + 2 + 12 + 1 }
		: { time: 8, lead: 6, label: 14, detailAt: 6 + 8 + 3 + 2 + 14 + 1 };

function eventRow(ctx: Ctx, e: Event, k: Cols): Line {
	const p = e.phrase;
	const room = ctx.W - k.detailAt - 9;
	const detail =
		e.row.stage === "dispatched" || ctx.narrow
			? (p.short ?? p.detail)
			: detailFor({ ...p, extra: undefined }, room);
	const right = p.fold
		? ctx.g.fold
		: e.durationMs !== undefined
			? clock(e.durationMs, ctx.narrow)
			: "";
	const left: Line = [
		sp(k.lead),
		{ text: hhmm(e.at, !ctx.narrow), role: "dim" },
		sp(ctx.narrow ? 2 : 3),
		{ text: ctx.g.event[p.glyph], role: p.role },
		sp(1),
		...cell(p.label, k.label, p.role === "landed" ? "landed" : "ink", {
			bold: p.role === "landed",
		}),
		sp(1),
		...marked(detail, "ink2"),
	];
	return lr(left, right ? [{ text: right, role: "dim" }] : [], ctx.W);
}

function phaseRow(ctx: Ctx, c: ChildView, k: Cols): Line {
	const since = c.phaseSince ?? "";
	const ago = since ? age(ctx.tick.now - Date.parse(since)) : "";
	let detail: Line;
	if (c.phase === "exit gate")
		detail = [{ text: `running ${ago}`, role: "running" }];
	else if (c.phase === "quiet")
		detail = [{ text: `no update for ${ago}`, role: "dim" }];
	else detail = [{ text: `${ago} since its last update`, role: "ink2" }];
	return [
		sp(k.lead),
		{ text: since ? hhmm(since, !ctx.narrow) : "", role: "dim" },
		sp(ctx.narrow ? 2 : 3),
		childGlyph(ctx, c),
		sp(1),
		...cell(phaseWord(c), k.label, c.phase === "quiet" ? "dim" : "running"),
		sp(1),
		...detail,
	];
}

function foldLines(ctx: Ctx, e: Event, k: Cols): Line[] {
	if (!e.phrase.fold) return [];
	const n = ctx.state.expanded.includes(e.id) ? 12 : 2;
	return quote(ctx, e.phrase.fold, k.detailAt, n, e.phrase.role);
}

/** `⠇ running    attempt 2    sonnet    12m 04s    127k tokens    #418 · 3f9e2c1`. */
function stateLines(ctx: Ctx, c: ChildView): Line[] {
	const g = childGlyph(ctx, c);
	const role =
		c.state === "running" && c.phase === "quiet" ? "dim" : STATE_ROLE[c.state];
	const clockText =
		c.state === "running" && c.phase !== "quiet"
			? ticking(ctx, c.elapsedMs)
			: c.elapsedMs !== undefined
				? clock(c.elapsedMs, ctx.narrow)
				: "";
	const tok = c.tokens
		? c.tokensCounting
			? ctx.narrow
				? `${tokens(c.tokens)} tokens before`
				: `${tokens(c.tokens)} tokens before this attempt`
			: `${tokens(c.tokens)} tokens`
		: "";
	const pr = c.pr
		? `#${c.pr}${c.prNote ? ` · ${c.prNote}` : c.sha ? ` · ${c.sha}` : ""}`
		: c.attempt
			? "no PR yet"
			: "";
	const first = [
		c.attempt ? `attempt ${c.attempt}` : "",
		c.model?.requested ?? "",
		clockText,
	].filter(Boolean);
	const second = [tok, pr].filter(Boolean);
	const at = indent(ctx);
	const head: Line = [
		sp(at),
		g,
		{
			text: ` ${c.state === "running" && c.phase === "quiet" ? "quiet" : c.state}`,
			role,
		},
	];
	if (ctx.narrow) {
		const out: Line[] = [
			[
				...head,
				{ text: first.length ? ` · ${first.join(" · ")}` : "", role: "ink2" },
			],
		];
		if (second.length)
			out.push([sp(at), { text: second.join(" · "), role: "ink2" }]);
		return out;
	}
	return [
		[
			...head,
			{
				text: [...first, ...second].map((x) => `    ${x}`).join(""),
				role: "ink2",
			},
		],
	];
}

/**
 * The top of a wide Child page, as the Run page's labelled grid: `child` with its wave
 * and summary, `state` with its attempt, model, time and tokens, then `pr`.
 */
function childGrid(ctx: Ctx, c: ChildView): Line[] {
	const at = indent(ctx);
	const row = (label: string, value: Line): Line =>
		truncate(
			[sp(at), { text: label.padEnd(GRID_LABEL), role: "dim" }, ...value],
			ctx.W,
		);
	const dot: Span = { text: " · ", role: "dim" };
	const quiet = c.state === "running" && c.phase === "quiet";
	const clockText =
		c.state === "running" && !quiet
			? ticking(ctx, c.elapsedMs)
			: c.elapsedMs !== undefined
				? clock(c.elapsedMs, false)
				: "";
	const tok = c.tokens
		? `${tokens(c.tokens)} tokens${c.tokensCounting ? " before this attempt" : ""}`
		: "";
	const facts = [
		c.attempt ? `attempt ${c.attempt}` : "",
		c.model?.requested ?? "",
		clockText,
		tok,
	].filter(Boolean);
	const out: Line[] = [
		row("child", [
			{ text: c.key, role: STATE_ROLE[c.state], bold: true },
			{ text: ` · wave ${c.wave}`, role: "dim" },
		]),
		row("", [
			{
				text: c.summary || "—",
				role: c.summary ? "ink" : "dim",
				bold: !!c.summary,
			},
		]),
		row("state", [
			childGlyph(ctx, c),
			{
				text: ` ${quiet ? "quiet" : c.state}`,
				role: quiet ? "dim" : STATE_ROLE[c.state],
			},
			...facts.flatMap((f): Span[] => [dot, { text: f, role: "ink2" }]),
		]),
	];
	if (c.pr || c.attempt)
		out.push(
			row(
				"pr",
				c.pr
					? [
							...linked(
								[{ text: `#${c.pr}`, role: "accent" }],
								webOf(ctx, ctx.state.runKey ?? "").pr(c.pr),
							),
							...(c.prNote
								? [dot, { text: c.prNote, role: "ink2" as const }]
								: c.sha
									? [dot, { text: c.sha, role: "dim" as const }]
									: []),
						]
					: [{ text: "no PR yet", role: "dim" }],
			),
		);
	return out;
}

/** The newest message, unless the current attempt has passed a gate since it was written. */
function lastMessage(ctx: Ctx, c: ChildView): Line | undefined {
	const msg = c.lastMessage;
	if (!msg) return undefined;
	const old = msg.attempt > 0 && msg.attempt !== c.attempt;
	const superseded =
		old &&
		c.attempts.some(
			(a) =>
				a.n === c.attempt &&
				a.events.some(
					(e) =>
						e.row.stage === "gate" && e.row.status === "pass" && e.at > msg.at,
				),
		);
	if (superseded) return undefined;
	return truncate(
		[
			sp(indent(ctx)),
			{ text: ctx.g.quote, role: msg.role },
			sp(1),
			...(old
				? [{ text: `attempt ${msg.attempt} · `, role: "dim" as const }]
				: []),
			{ text: msg.text.split("\n")[0] ?? "", role: "ink2", italic: true },
		],
		ctx.W,
	);
}

function needsLines(ctx: Ctx, r: RunView, c: ChildView): Line[] {
	const at = indent(ctx);
	const lw = ctx.narrow ? 10 : GRID_LABEL;
	return (c.needs ?? []).map((n, i) => {
		const other = r.children.find((x) => x.key === n.key);
		const line: Line = [
			sp(at),
			i ? sp(lw) : { text: "needs".padEnd(lw), role: "dim" },
			{ text: ctx.g.state[n.state], role: STATE_ROLE[n.state] },
			sp(1),
			{ text: n.key, role: "ink" },
		];
		if (!ctx.narrow && other?.summary)
			line.push(sp(2), { text: other.summary, role: "ink2" });
		return truncate(line, ctx.W);
	});
}

/** A section: a blank, its letter-spaced label with a quiet note on the right, a blank. */
const section = (ctx: Ctx, title: string, note?: string | number): Line[] => [
	[],
	label(ctx, title, note),
	[],
];

const kv = (ctx: Ctx, key: string, value: Line): Line => {
	const lw = ctx.narrow ? 10 : 14;
	return truncate(
		[sp(indent(ctx)), { text: key.padEnd(lw), role: "dim" }, ...value],
		ctx.W,
	);
};

/** `attempt 2` where there is room, `try 2` below 100 columns. */
export const attemptWord = (ctx: Ctx, n: number) =>
	ctx.narrow ? `try ${n}` : `attempt ${n}`;

function gateLines(
	ctx: Ctx,
	c: ChildView,
	push: (id: string | undefined, line: () => Line) => void,
	body: Lazy[],
): void {
	const at = indent(ctx);
	const kw = ctx.narrow ? 6 : 7;
	const aw = ctx.narrow ? 7 : 11;
	const row = (
		kind: string,
		attempt: number | undefined,
		line: Line,
		right?: string,
	): Line =>
		lr(
			[
				sp(at),
				...cell(kind, kw, "dim"),
				...cell(attempt ? attemptWord(ctx, attempt) : "", aw, "dim"),
				...line,
			],
			right ? [{ text: right, role: "dim" }] : [],
			ctx.W,
		);
	const when = (g: { gate: { at: string }; ms?: number }) =>
		ctx.narrow
			? ""
			: [hhmm(g.gate.at), g.ms !== undefined ? clock(g.ms) : ""]
					.filter(Boolean)
					.join(" · ");
	const shown = shownGates(c);
	let exitSeen = false;
	for (const { kind, g } of shown) {
		const label = kind === "exit" && exitSeen ? "" : kind;
		if (kind === "exit") exitSeen = true;
		if (!g) {
			const since = c.phaseSince
				? age(ctx.tick.now - Date.parse(c.phaseSince))
				: "";
			body.push(
				row(label, c.attempt, [
					{ text: `running${since ? ` ${since}` : ""}`, role: "running" },
				]),
			);
			continue;
		}
		const line = () => {
			const right = when(g);
			const room = ctx.W - at - kw - aw - (right ? strWidth(right) + 2 : 0);
			return row(
				label,
				g.attempt.n,
				stepsLine(ctx, g.gate, ctx.narrow, room),
				right,
			);
		};
		if (g.gate.pass) {
			body.push(line());
			continue;
		}
		const text = failureText(g.attempt, g.gate);
		const id = text ? gateItem(c, kind, g.attempt.n) : undefined;
		push(id, line);
		const from = at + kw + aw;
		const failed = g.gate.steps.find((s) => s.ok === false)?.name;
		if (text) {
			// ⏎ on the row opens the whole reason, as an attempt's folded row does.
			const open = id !== undefined && ctx.state.expanded.includes(id);
			body.push(...quote(ctx, text, from, open ? 12 : 4, "failed"));
		} else if (failed && g.gate.steps.some((s) => s.ok === null))
			body.push([
				sp(from),
				{
					text: `stopped at ${failed}; the steps after it never ran`,
					role: "dim",
				},
			]);
	}
	if (!shown.length)
		body.push([
			sp(at),
			{
				text: c.attempt ? "no gate has run yet" : "not dispatched yet",
				role: "dim",
			},
		]);
}

function filesLines(ctx: Ctx, c: ChildView): Line[] {
	const at = indent(ctx);
	const f = filesSummary(c);
	const out: Line[] = [
		truncate([sp(at), { text: f.text, role: f.role }], ctx.W),
	];
	const shown = f.paths.slice(0, 5);
	for (const p of shown) {
		const line: Line = [
			sp(at + 2),
			{ text: ctx.g.dot, role: "dim" },
			sp(1),
			{ text: p.path, role: "ink" },
		];
		if (p.why && !ctx.narrow)
			line.push(
				{ text: ` ${ctx.g.dash} `, role: "dim" },
				{ text: p.why, role: "ink2" },
			);
		out.push(truncate(line, ctx.W));
		if (p.why && ctx.narrow)
			out.push(
				truncate(
					[
						sp(at + 4),
						{ text: ctx.g.quote, role: "rule" },
						sp(1),
						{ text: p.why, role: "ink2", italic: true },
					],
					ctx.W,
				),
			);
	}
	if (f.paths.length > shown.length)
		out.push([
			sp(at + 2),
			{ text: `+${f.paths.length - shown.length} more`, role: "dim" },
		]);
	// An approval a file outside used is told above; only the ones nothing needed are listed.
	if (f.unused.length) {
		out.push([], [sp(at), { text: "approved extra paths", role: "dim" }]);
		const gw = globWidth(f.unused, ctx.narrow, ctx.size.cols);
		for (const a of f.unused)
			out.push(...approvalRow(ctx, a, at + 2, ctx.narrow, gw));
	}
	return out;
}

const LOG_ROLE: Record<LogKind, Role> = {
	init: "dim",
	say: "ink2",
	tool: "accent",
	out: "dim",
	error: "failed",
	result: "done",
	raw: "ink2",
};

/** One log line: a tool call leads with `›`, its answer with `‹`. */
export function logLine(
	ctx: Ctx,
	l: LogLine,
	at: number,
	w: number,
	withLead = true,
): Line {
	const lead = !withLead
		? ""
		: l.kind === "tool"
			? ctx.ink.unicode
				? "› "
				: "> "
			: l.kind === "out" || l.kind === "error"
				? ctx.ink.unicode
					? "‹ "
					: "< "
				: "";
	return truncate(
		[
			sp(at),
			...(lead ? [{ text: lead, role: LOG_ROLE[l.kind] }] : []),
			{ text: l.text, role: l.kind === "tool" ? "ink" : LOG_ROLE[l.kind] },
		],
		at + w,
	);
}

const STATUS_ROLE = {
	alive: "running",
	stalled: "parked",
	exited: "failed",
	finished: "done",
} as const;

export function workerStatusText(c: ChildView): Span[] {
	const w = c.worker;
	if (w?.kind !== "detached") return [];
	const status = w.status ?? "alive";
	const parts: string[] = [];
	if (w.pid !== undefined) parts.push(`pid ${w.pid}`);
	if (w.account) parts.push(`account ${w.account}`);
	const out: Span[] = [
		{ text: parts.join(" · "), role: "ink2" },
		{ text: parts.length ? " · " : "", role: "dim" },
		{ text: status, role: STATUS_ROLE[status] },
	];
	if (w.startedAt)
		out.push({ text: ` · started ${hhmm(w.startedAt)}`, role: "ink2" });
	if (w.quietMs !== undefined && status !== "finished")
		out.push({
			text:
				status === "stalled"
					? ` · no log output for ${age(w.quietMs)}`
					: ` · log quiet ${age(w.quietMs)}`,
			role: status === "stalled" ? "parked" : "dim",
		});
	return out;
}

function workerLines(
	ctx: Ctx,
	r: RunView,
	c: ChildView,
	push: (id: string | undefined, line: () => Line) => void,
	body: Lazy[],
): void {
	const at = indent(ctx);
	const w = c.worker;
	const env = c.env;
	const tree = worktreeOf(c);
	// A parked child waits on a person, who answers it in that same session.
	const live = c.state === "running" || c.state === "parked";
	if (!w && !env) {
		body.push([sp(at), { text: "not dispatched yet", role: "dim" }]);
		return;
	}
	const ownerGone = w?.kind === "subagent" && w.owner?.alive === false;
	if (w?.kind === "detached")
		push(workerItem(c), () =>
			lr(kv(ctx, "process", workerStatusText(c)), [], ctx.W),
		);
	else if (w) {
		const where = ctx.narrow
			? "the orchestrator's session"
			: "the orchestrator's Claude Code session";
		const text =
			live && !ownerGone
				? `runs inside ${where}`
				: live
					? `ran inside ${where}, which has ended`
					: `ran inside ${where}`;
		push(workerItem(c), () => kv(ctx, "session", [{ text, role: "ink2" }]));
	}
	// Once the child has stopped there is no one to reach: only where it worked is left.
	if (w?.kind === "subagent" && live) {
		const o = w.owner;
		const value: Span[] = !o
			? [
					{
						text: "pid not recorded · switch to the terminal that ran /portia",
						role: "dim",
					},
				]
			: o.alive === false
				? [
						{ text: `pid ${o.pid}`, role: "ink2" },
						{ text: " · ", role: "dim" },
						{ text: "gone", role: "failed" },
						{ text: " · ", role: "dim" },
						{ text: `portia resume ${r.key}`, role: "accent" },
						{ text: " picks this child up", role: "dim" },
					]
				: [
						{ text: `pid ${o.pid}`, role: "ink2" },
						{ text: " · ", role: "dim" },
						{ text: "alive", role: "running" },
						...(o.tty
							? [
									{ text: " · ", role: "dim" as const },
									{ text: o.tty, role: "ink2" as const },
									{
										text: " · switch to that terminal",
										role: "dim" as const,
									},
								]
							: [
									{
										text: " · switch to the terminal that ran /portia",
										role: "dim" as const,
									},
								]),
					];
		body.push(kv(ctx, ctx.narrow ? "owner" : "orchestrator", value));
	}
	if (tree.path)
		body.push(
			kv(
				ctx,
				"worktree",
				tree.removedAt !== undefined
					? [
							{
								text: `removed ${tree.removedAt ? hhmm(tree.removedAt) : ""}`.trim(),
								role: "dim",
							},
							{ text: ` (was ${tilde(tree.path)})`, role: "dim" },
						]
					: [{ text: tilde(tree.path), role: "ink2" }],
			),
		);
	if (env) {
		const parts: Span[] = [
			{ text: env.branch || c.branch || "", role: "ink2" },
		];
		const add = (k: string, v: string) =>
			parts.push(
				sp(ctx.narrow ? 2 : 4),
				{ text: `${k} `, role: "dim" },
				{ text: v, role: "ink2" },
			);
		if (env.port !== undefined) add("port", String(env.port));
		if (env.db) add("db", env.db);
		parts.push(
			sp(ctx.narrow ? 2 : 4),
			env.up
				? {
						text: `up since ${env.since ? hhmm(env.since) : "?"}`,
						role: "ink2",
					}
				: {
						text: `torn down ${env.since ? hhmm(env.since) : ""}`.trim(),
						role: "dim",
					},
		);
		body.push(kv(ctx, "branch", parts));
	}
	if (w?.kind === "detached") {
		const tail = w.lines.slice(-8);
		body.push([]);
		if (!tail.length)
			body.push([sp(at + 2), { text: "the log is empty so far", role: "dim" }]);
		for (const l of tail)
			body.push(() => [
				sp(at),
				{ text: ctx.g.quote, role: "rule" },
				...logLine(ctx, l, 1, ctx.W - at - 2),
			]);
	}
	const here = tree.path && tree.removedAt === undefined;
	const keys = [
		w?.kind === "detached" ? "w opens the full log" : "",
		here ? "y copies the worktree" : "",
		here ? "e opens it in $EDITOR" : "",
	].filter(Boolean);
	if (keys.length && !ctx.narrow)
		body.push([], [sp(at), { text: keys.join(" · "), role: "dim" }]);
}

/** The Child page's keys: only the ones that do something for this child. */
export const CHILD_HINTS = (c: ChildView): string[] => {
	const tree = worktreeOf(c);
	const here = !!tree.path && tree.removedAt === undefined;
	return [
		"↑↓ move",
		"⏎ expand",
		c.worker?.kind === "detached" ? "w worker log" : "",
		c.pr ? "o PR" : "",
		here ? "y copy worktree" : "",
		here ? "e editor" : "",
		"← back",
		"? help",
	];
};

export function childScreen(ctx: Ctx, r: RunView, c: ChildView): Line[] {
	const at = indent(ctx);
	const k = cols(ctx);
	const ids = childItems(c, ctx.state);
	const sel = selectedId(ctx.state, `child:${r.key}:${c.key}`, ids);
	// Event rows are built only near the viewport: a child with thousands of rows
	// over many attempts would otherwise cost a full rebuild on every spinner tick.
	const body: Lazy[] = [];
	const items: number[] = [];
	let selAt: number | undefined;
	const push = (id: string | undefined, line: () => Line) => {
		if (id !== undefined) items.push(body.length);
		if (id !== undefined && id === sel) {
			selAt = body.length;
			body.push(() => selected(ctx, line()));
		} else body.push(line);
	};
	// On a short terminal the headline holds still above the scroll, in two rows,
	// so a child scrolled down to its attempts still says which child it is.
	const pin = ctx.size.rows < 30;
	const states = stateLines(ctx, c);
	const pinned: Line[] = [];
	if (pin) {
		pinned.push(
			truncate(
				[
					sp(at),
					{ text: c.key, role: "ink", bold: true },
					{ text: ` · wave ${c.wave}`, role: "dim" },
					...(c.summary
						? [sp(2), { text: c.summary, role: "ink" as const }]
						: []),
				],
				ctx.W,
			),
			states[0] ?? [],
		);
		body.push(...states.slice(1));
	} else if (ctx.narrow) {
		body.push([]);
		body.push([sp(at), { text: `${c.key}  ·  wave ${c.wave}`, role: "dim" }]);
		body.push([
			sp(at),
			{
				text: c.summary || "—",
				role: c.summary ? "ink" : "dim",
				bold: !!c.summary,
			},
		]);
		body.push([]);
		body.push(...states);
	} else body.push([], ...childGrid(ctx, c));
	// A park says why it waits and, for the person, the whole question, before anything else.
	const why = waitHead(ctx, c);
	if (why && c.wait) {
		const ask = c.wait.kind === "question";
		body.push([sp(at), why]);
		if (c.wait.text)
			body.push(
				...quote(ctx, c.wait.text, at, ask ? 40 : 2, ask ? "parked" : "dim"),
			);
	} else {
		const msg = lastMessage(ctx, c);
		if (msg) body.push(msg);
	}
	const needs = needsLines(ctx, r, c);
	if (needs.length) body.push([], ...needs);

	// Evidence: what the child proves, and what its worker reported for each.
	const evIds = evidenceIds(c);
	const final = settled(c.state);
	const proven = c.requirements.filter((q) => q.ok).length;
	body.push(
		...section(
			ctx,
			"EVIDENCE",
			c.requirements.length
				? `${proven} of ${c.requirements.length} proven${final || proven === c.requirements.length ? "" : " so far"}`
				: undefined,
		),
	);
	if (!evIds.length)
		body.push([
			sp(at),
			{
				text:
					r.source === "plan"
						? "the plan lists nothing for it to prove"
						: "no plan snapshot: what it proves is not known",
				role: "dim",
			},
		]);
	const idW = Math.max(3, ...evIds.map((id) => strWidth(id))) + 1;
	for (const id of evIds) {
		const q = c.requirements.find((x) => x.id === id);
		const mark: Span =
			q?.ok || (!q && c.evidence[id])
				? { text: ctx.g.check, role: "landed" }
				: q?.ok === false && final
					? { text: ctx.g.cross, role: "failed" }
					: { text: ctx.g.dot, role: "faint" };
		const text = q?.text ?? (q ? "" : "reported, not in the plan");
		push(evItem(c, id), () =>
			truncate(
				[
					sp(at),
					...cell(id, idW, "accent"),
					mark,
					sp(2),
					{ text, role: q ? "ink2" : "dim" },
				],
				ctx.W,
			),
		);
		const open = ctx.state.expanded.includes(evItem(c, id));
		const n = open ? 30 : 2;
		const quoteAt = at + idW + 3;
		const landed = c.evidence[id];
		const stale = c.unlandedEvidence?.evidence[id];
		if (landed) body.push(...quote(ctx, landed, quoteAt, n, "accent"));
		else if (stale)
			body.push(
				...quote(
					ctx,
					`attempt ${c.unlandedEvidence?.attempt}, not landed: ${stale}`,
					quoteAt,
					n,
					"rule",
					{ role: "dim" },
				),
			);
		else
			body.push([
				sp(quoteAt),
				{
					text:
						c.state === "pending" || c.state === "ready"
							? "not run yet"
							: "no evidence reported yet",
					role: "faint",
				},
			]);
	}

	body.push(...section(ctx, "GATES"));
	gateLines(ctx, c, push, body);
	body.push(...section(ctx, "FILES"), ...filesLines(ctx, c));
	body.push(
		...section(
			ctx,
			"WORKER",
			c.worker
				? c.worker.kind === "detached"
					? "detached"
					: "subagent"
				: undefined,
		),
	);
	workerLines(ctx, r, c, push, body);

	if (c.attempts.length) {
		body.push(...section(ctx, "ATTEMPTS", c.attempts.length));
		[...c.attempts].reverse().forEach((a, i) => {
			const open = attemptOpen(ctx.state, c, a.n);
			if (i) body.push([]);
			push(attemptItem(c, a.n), () => asHead(attemptTitle(ctx, c, a, open)));
			if (!open) return;
			for (const e of a.events) {
				push(e.id, () => eventRow(ctx, e, k));
				body.push(...foldLines(ctx, e, k));
			}
			if (a.outcome === "running")
				push(phaseItem(c), () => phaseRow(ctx, c, k));
		});
	}
	const running = c.state === "running" && c.phase !== "quiet";
	const clockText = running ? ticking(ctx, c.elapsedMs) : "";
	const right: Line = ctx.narrow
		? [
				childGlyph(ctx, c),
				{ text: ` ${clockText || clockNow(ctx)}`, role: "dim" },
			]
		: [
				childGlyph(ctx, c),
				{ text: ` ${phaseWord(c)}`, role: "ink2" },
				{
					text: `${clockText ? ` · ${clockText}` : ""} · ${clockNow(ctx)}`,
					role: "dim",
				},
			];
	return compose(ctx, {
		top: [
			...pageHeader(ctx, childCrumbs(ctx, r.key, c.key), right),
			rule(ctx),
			...pinned,
		],
		body,
		sel: selAt,
		items,
		scrollKey: `child:${r.key}:${c.key}`,
		fill: true,
		footer: footer(ctx, hints(ctx, CHILD_HINTS(c))),
	});
}
