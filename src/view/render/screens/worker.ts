import type { ChildView, RunView } from "../../model/types";
import { LOG_TAIL, type LogLine } from "../../model/worker";
import { workerScrollKey } from "../../runtime/state";
import { worktreeOf } from "../../select";
import {
	type Ctx,
	childGlyph,
	clockNow,
	hints,
	indent,
	pageHeader,
	rule,
	selected,
	shortPath,
	tilde,
} from "../common";
import { compose } from "../frame";
import { footer } from "../overlays";
import { type Line, lr, type Span, sp, truncate, wrap } from "../text";
import { logLine, workerStatusText } from "./child";

const HINTS = (searching: boolean, here: boolean) => [
	searching ? "↑↓ match" : "↑↓ scroll",
	"end follow",
	"/ search",
	searching ? "n next" : "",
	searching ? "N previous" : "",
	here ? "y copy worktree" : "",
	here ? "e editor" : "",
	"← back",
	"? help",
];

const size = (n: number) =>
	n >= 1024 * 1024
		? `${(n / 1024 / 1024).toFixed(1)} MB`
		: `${Math.max(1, Math.round(n / 1024))} KB`;

interface Row {
	line: LogLine;
	text: string;
	first: boolean;
}

// A log wraps the same way every frame; it is rebuilt only when the lines or the width change.
const rowsMemo = new WeakMap<LogLine[], { w: number; rows: Row[] }>();
function logRows(lines: LogLine[], w: number): Row[] {
	const hit = rowsMemo.get(lines);
	if (hit && hit.w === w) return hit.rows;
	const rows: Row[] = [];
	for (const line of lines) {
		const parts = wrap(line.text, w);
		parts.forEach((text, i) => {
			rows.push({ line, text, first: i === 0 });
		});
	}
	rowsMemo.set(lines, { w, rows });
	return rows;
}

/** A row with every case-insensitive occurrence of `q` underlined in accentBright. */
function marked(l: Line, q: string): Line {
	if (!q) return l;
	const needle = q.toLowerCase();
	const out: Line = [];
	for (const s of l) {
		const hay = s.text.toLowerCase();
		let i = 0;
		let at = hay.indexOf(needle);
		if (at < 0) {
			out.push(s);
			continue;
		}
		while (at >= 0) {
			if (at > i) out.push({ ...s, text: s.text.slice(i, at) });
			out.push({
				...s,
				text: s.text.slice(at, at + needle.length),
				role: "accentBright",
				underline: true,
			});
			i = at + needle.length;
			at = hay.indexOf(needle, i);
		}
		if (i < s.text.length) out.push({ ...s, text: s.text.slice(i) });
	}
	return out;
}

/** A detached worker's whole log, live: read-only, scrollable, searchable. */
export function workerScreen(ctx: Ctx, r: RunView, c: ChildView): Line[] {
	const at = indent(ctx);
	const w = c.worker;
	const crumbs: Line[] = [
		[{ text: r.key, role: "ink" }],
		[{ text: c.key, role: "ink" }],
		[{ text: "worker", role: "ink" }],
	];
	// A spinner only while the worker is alive and writing; otherwise its state's mark.
	const glyph: Span =
		w?.status === "stalled"
			? { text: ctx.g.state.running, role: "parked" }
			: w?.status === "exited"
				? { text: ctx.g.state.failed, role: "failed" }
				: w?.status === "finished"
					? { text: ctx.g.state.done, role: "done" }
					: childGlyph(ctx, c);
	const right: Line = [
		glyph,
		{ text: ` ${w?.status ?? c.state}`, role: "ink2" },
		{ text: ` · ${clockNow(ctx)}`, role: "dim" },
	];
	const top: Line[] = [...pageHeader(ctx, crumbs, right), rule(ctx)];
	const tree = worktreeOf(c);
	const here = !!tree.path && tree.removedAt === undefined;
	const foot = (m?: { m: number; n: number }) =>
		footer(ctx, hints(ctx, HINTS(!!ctx.state.filter?.text, here)), m);
	if (w?.kind !== "detached") {
		const say = (text: string): Line => [sp(at), { text, role: "ink2" }];
		const body: Line[] = !w
			? [[], say("Not dispatched yet: there is no worker for this child.")]
			: [
					[],
					say(
						"This worker is a subagent: it runs inside the orchestrator's Claude Code session",
					),
					say("and keeps no log of its own. Open that session to see it work."),
				];
		return compose(ctx, { top: [...top, []], body, footer: foot() });
	}
	const worktree = c.env?.worktree || w.worktree;
	const file = w.logPath?.split("/").at(-1) ?? "";
	const meta: Line = lr(
		[sp(at), ...workerStatusText(c)],
		ctx.narrow
			? []
			: [
					{
						text: [file, w.logBytes !== undefined ? size(w.logBytes) : ""]
							.filter(Boolean)
							.join(" · "),
						role: "dim",
					},
				],
		ctx.W,
	);
	const where: Line = truncate(
		[
			sp(at),
			{
				text: worktree
					? shortPath(tilde(worktree), ctx.W - at - 30, ctx.ink.unicode)
					: "no worktree recorded",
				role: "ink2",
			},
			...(c.env?.branch || c.branch
				? [
						{ text: " · ", role: "dim" as const },
						{ text: c.env?.branch || c.branch || "", role: "ink2" as const },
					]
				: []),
		],
		ctx.W,
	);
	const q = ctx.state.filter?.text ?? "";
	const following = ctx.state.tail && !q;
	const textW = Math.max(10, ctx.W - at - 3);
	const rows = logRows(w.lines, textW);
	const matches: number[] = [];
	if (q) {
		const needle = q.toLowerCase();
		rows.forEach((row, i) => {
			if (row.text.toLowerCase().includes(needle)) matches.push(i);
		});
	}
	const lead = w.logCut ? 1 : 0;
	let sel: number | undefined;
	let idx = -1;
	if (q && matches.length) {
		const m = ctx.state.match;
		idx =
			m === undefined
				? matches.length - 1
				: ((m % matches.length) + matches.length) % matches.length;
		sel = (matches[idx] ?? 0) + lead;
	} else if (following) sel = rows.length - 1 + lead;
	const status: Span = q
		? {
				text: matches.length
					? `${idx + 1} of ${matches.length} matches`
					: "no match",
				role: matches.length ? "accent" : "dim",
			}
		: following
			? { text: "following the end", role: "dim" }
			: { text: "paused · end follows", role: "accent" };
	top.push(meta, lr(where, [status], ctx.W), []);
	const body: (Line | (() => Line))[] = [];
	if (w.logCut)
		body.push([
			sp(at),
			{
				text: `${ctx.g.ellipsis} earlier output not shown: the view reads the last ${size(LOG_TAIL)} of ${size(w.logBytes ?? 0)}`,
				role: "dim",
			},
		]);
	if (!rows.length)
		body.push([sp(at), { text: "the log is empty so far", role: "dim" }]);
	rows.forEach((row, i) => {
		const isSel = i + lead === sel && !!q;
		const build = (): Line => {
			// A wrapped line's continuation hangs two cells in, without the lead mark.
			const l = row.first
				? logLine(ctx, { ...row.line, text: row.text }, at, textW + 2)
				: logLine(ctx, { ...row.line, text: row.text }, at + 2, textW, false);
			const m = q ? marked(l, q) : l;
			return isSel ? selected(ctx, m) : m;
		};
		body.push(build);
	});
	return compose(ctx, {
		top,
		body,
		sel,
		scrollKey: workerScrollKey(ctx.state),
		footer: foot(q ? { m: matches.length, n: rows.length } : undefined),
	});
}
