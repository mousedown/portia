import { clock } from "../../model/format";
import type { ChildView, RunView } from "../../model/types";
import { attentionChild, gateChildren, selectedId } from "../../select";
import { type Ctx, indent, STATE_ROLE, selected } from "../common";
import { type Line, type Span, sp } from "../text";
import { epicLine, lastExit, shortStep } from "./children";

const markOf = (ctx: Ctx, ok: boolean | null | undefined): Span =>
	ok === true
		? { text: ctx.g.matrix.pass, role: "done" }
		: ok === false
			? { text: ctx.g.matrix.fail, role: "failed" }
			: { text: ctx.g.matrix.none, role: "faint" };

/** One mark centred-ish in a cell of w: two spaces, then the mark. */
const markCell = (
	ctx: Ctx,
	ok: boolean | null | undefined,
	w: number,
): Line => [sp(2), markOf(ctx, ok), sp(w - 3)];

function lastOf(ctx: Ctx, c: ChildView): Span {
	if (c.state === "running") {
		if (c.phase === "exit gate") return { text: "running", role: "running" };
		return { text: c.phase === "quiet" ? "quiet" : "working", role: "dim" };
	}
	const exit = lastExit(c);
	if (!exit) return { text: c.state, role: STATE_ROLE[c.state] ?? "dim" };
	const a = c.attempts.find((x) => x.n === exit.attempt);
	const ev = a?.events.find(
		(e) => e.row.stage === "gate" && e.at === exit.gate.at,
	);
	return {
		text: ev?.durationMs !== undefined ? clock(ev.durationMs, ctx.narrow) : "",
		role: "ink2",
	};
}

/** Why a gate stopped early, for the selected row. */
function explain(ctx: Ctx, c: ChildView | undefined): Line | undefined {
	if (!c) return undefined;
	const exit = lastExit(c);
	if (!exit) return undefined;
	const failed = exit.gate.steps.find((s) => s.ok === false);
	if (!failed || !exit.gate.steps.some((s) => s.ok === null)) return undefined;
	const text = ctx.narrow
		? `${c.key} try ${exit.attempt} · stopped at ${failed.name}`
		: `${c.key} · attempt ${exit.attempt} · exit gate stopped at ${failed.name}; steps after it never ran (${ctx.g.matrix.none})`;
	return [sp(indent(ctx)), { text, role: "ink2" }];
}

export function gatesBody(
	ctx: Ctx,
	r: RunView,
): { lines: Line[]; sel?: number; items: number[] } {
	const kids = gateChildren(r, ctx.state);
	const items: number[] = [];
	const sel = selectedId(
		ctx.state,
		`run:${r.key}:gates`,
		kids.map((c) => c.key),
		attentionChild(
			r.children,
			kids.map((c) => c.key),
		),
	);
	const K = Math.max(8, ...kids.map((c) => c.key.length));
	const cw = ctx.narrow ? 5 : 6;
	const at = indent(ctx);
	const lead = ctx.narrow ? 2 + K + 2 + 4 + 5 : 3 + K + 2 + 6 + 6 + 2;
	const tail = ctx.narrow ? 0 : 2 + 8;
	const fits = Math.max(1, Math.floor((ctx.W - lead - tail) / cw));
	const steps = r.catalog.exit;
	const shown = steps.length > fits ? steps.slice(0, fits - 1) : steps;
	const hidden = steps.length - shown.length;
	const lines: Line[] = [];
	const bar: Span = { text: ctx.g.sep, role: "rule" };
	const head: Line = ctx.narrow
		? [
				sp(at + K + 2),
				{ text: "try ", role: "dim" },
				{ text: "task ", role: "dim" },
			]
		: [sp(3 + K + 2), { text: "tries task  ", role: "dim" }, bar, sp(1)];
	for (const s of shown)
		head.push({ text: shortStep(s).padEnd(cw), role: "dim" });
	if (hidden) head.push({ text: `+${hidden}`.padEnd(cw), role: "dim" });
	if (!ctx.narrow) head.push(bar, { text: " last", role: "dim" });
	lines.push(head);
	let selAt: number | undefined;
	for (const c of kids) {
		const isSel = c.key === sel;
		const exit = lastExit(c)?.gate;
		const task = [...c.attempts].reverse().find((a) => a.task)?.task;
		const named = new Map(exit?.steps.map((s) => [s.name, s.ok]));
		const row: Line = ctx.narrow
			? [
					sp(at),
					{ text: c.key.padEnd(K), role: "ink", bold: isSel },
					sp(2),
					{ text: ` ${c.attempt}`.padEnd(4), role: "ink2" },
					...markCell(ctx, task?.pass, 5),
				]
			: [
					sp(3),
					{ text: c.key.padEnd(K), role: "ink", bold: isSel },
					sp(2),
					{ text: `  ${c.attempt}`.padEnd(6), role: "ink2" },
					...markCell(ctx, task ? task.pass : null, 6),
					bar,
					sp(1),
				];
		for (const s of shown) row.push(...markCell(ctx, named.get(s) ?? null, cw));
		if (hidden) row.push(sp(cw));
		if (!ctx.narrow) row.push(bar, sp(1), lastOf(ctx, c));
		if (isSel) selAt = lines.length;
		items.push(lines.length);
		lines.push(isSel ? selected(ctx, row) : row);
	}
	if (!kids.length)
		lines.push([sp(at), { text: "no gate has run yet", role: "dim" }]);
	const lw = ctx.narrow ? 12 : 13;
	const lbl = (t: string): Span => ({ text: t.padEnd(lw), role: "dim" });
	lines.push([], epicLine(ctx, r, lw));
	const exits = r.events.filter(
		(e) => e.row.stage === "gate" && e.row.data?.kind === "exit",
	);
	const fails = new Map<string, number>();
	for (const e of exits) {
		const steps = Array.isArray(e.row.data?.steps)
			? (e.row.data?.steps as { name: string; ok: boolean }[])
			: [];
		for (const s of steps)
			if (s.ok === false) fails.set(s.name, (fails.get(s.name) ?? 0) + 1);
	}
	const heat = [...fails].sort((a, b) => b[1] - a[1]);
	const heatText = heat.length
		? ctx.narrow
			? heat
					.map(
						([n, k]) =>
							`${shortStep(n)} ${ctx.g.cross} ${k} of ${exits.length}`,
					)
					.join(", ")
			: `${heat.map(([n, k]) => `${n} ${ctx.g.cross} in ${k} of ${exits.length} exit gates`).join(", ")} · every other step clean`
		: "every step clean";
	lines.push([
		sp(at),
		lbl("often fails"),
		{ text: heatText, role: heat.length ? "ink2" : "dim" },
	]);
	lines.push([
		sp(at),
		lbl("baseline"),
		r.baseline.length
			? { text: r.baseline.join(", "), role: "parked" }
			: {
					text: ctx.narrow
						? "clean"
						: "clean · no step was failing on the base branch before the run",
					role: "dim",
				},
	]);
	if (r.skipped)
		lines.push([
			sp(at),
			{
				text: `${r.skipped} unreadable runlog line${r.skipped === 1 ? "" : "s"} skipped`,
				role: "parked",
			},
		]);
	const why = explain(
		ctx,
		kids.find((c) => c.key === sel),
	);
	if (why) lines.push([], why);
	return { lines, sel: selAt, items };
}
