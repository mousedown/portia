import picomatch from "picomatch";
import { monthDay } from "../../model/format";
import { byWords } from "../../model/phrase";
import type { Approval, ChildView } from "../../model/types";
import type { Ctx } from "../common";
import { cell, cutLeft, type Line, sp, strWidth, truncate } from "../text";

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** What a child's Files section says: one sentence, the paths it is about, and approvals nothing used. */
export interface FilesSummary {
	text: string;
	role: "ink2" | "parked" | "dim";
	/** The files outside its declared paths, each with why it was allowed when that is known. */
	paths: { path: string; why?: string }[];
	/** Extra paths a person approved that no file outside its declared paths needed. */
	unused: Approval[];
}

const matcher = (glob: string) => {
	try {
		return picomatch(glob, { dot: true });
	} catch {
		return (p: string) => p === glob;
	}
};

/** `by a person on Oct 20`, or `by two people` when the approvals disagree. */
function approvedBy(list: Approval[]): string {
	const who = [...new Set(list.map((a) => a.by || "person"))];
	const days = [
		...new Set(list.map((a) => (a.at ? monthDay(a.at, false) : ""))),
	];
	const by =
		who.length === 1 ? byWords(who[0] ?? "person") : `by ${who.join(" and ")}`;
	return days.length === 1 && days[0] ? `${by} on ${days[0]}` : by;
}

/**
 * Where a child's work stayed, in plain words: inside its declared paths, or outside them
 * and who allowed that. Every file outside is listed once, with its reason.
 */
export function filesSummary(c: ChildView): FilesSummary {
	const declared =
		c.touches === undefined
			? "its declared paths"
			: `its ${plural(c.touches.length, "declared path")}`;
	const tests = c.approvals.map((a) => ({ a, m: matcher(a.glob) }));
	const approvalOf = (p: string) => tests.find((t) => t.m(p))?.a;
	const used = new Set(
		c.outside.map(approvalOf).filter((a): a is Approval => !!a),
	);
	const unused = c.approvals.filter((a) => !used.has(a));
	if (c.touchesMatched === true)
		return {
			text: `stayed inside ${declared}`,
			role: "ink2",
			paths: [],
			unused,
		};
	if (c.touchesMatched === false) {
		const n = c.outside.length;
		const files = n ? plural(n, "file") : "files";
		const head = `changed ${files} outside ${declared}`;
		const paths = c.outside.map((path) => ({
			path,
			why: approvalOf(path)?.why,
		}));
		const d = c.touchesDecision;
		const every = n > 0 && c.outside.every((p) => approvalOf(p));
		if (every && d?.answer !== "park" && d?.answer !== "retry") {
			const all = n === 1 ? "" : n === 2 ? "both " : "all ";
			return {
				text: `${head}, ${all}approved ${approvedBy([...used])}:`,
				role: "ink2",
				paths,
				unused,
			};
		}
		const decided = !d
			? "waiting on a decision"
			: d.answer === "accept"
				? d.by === "rule" || !d.by
					? "accepted automatically (allowed incidental files)"
					: `accepted ${byWords(d.by)}`
				: d.answer === "park"
					? "parked for a person to decide"
					: d.answer === "retry"
						? "sent back to try again"
						: `${d.answer} ${byWords(d.by)}`.trim();
		return {
			text: `${head}, ${decided}${n ? ":" : ""}`,
			role: d?.answer === "accept" ? "ink2" : "parked",
			paths: paths.map((p) =>
				p.why || d?.answer !== "accept" || (d.by && d.by !== "rule")
					? p
					: { ...p, why: "an allowed incidental file" },
			),
			unused,
		};
	}
	return {
		text:
			c.touches === undefined
				? "checked when the worker reports"
				: `declares ${plural(c.touches.length, "path")} · checked when the worker reports`,
		role: "dim",
		paths: [],
		unused,
	};
}

/** The glob column: as wide as the widest glob, within limits, so a path keeps its file. */
export function globWidth(
	approvals: Approval[],
	narrow: boolean,
	cols = 0,
): number {
	const widest = Math.max(12, ...approvals.map((a) => strWidth(a.glob)));
	return Math.min(widest, narrow ? 26 : cols >= 140 ? 56 : 40);
}

export function approvalRow(
	ctx: Ctx,
	a: Approval,
	at: number,
	narrow: boolean,
	gw = globWidth([a], narrow),
): Line[] {
	const when = `${a.by || "person"} · ${monthDay(a.at)}`;
	// Paths are cut from the left: the file at the end is the part that says what was approved.
	const glob = (): Line => {
		const t = cutLeft(a.glob, gw, ctx.ink.unicode ? "…" : "...");
		return [{ text: t, role: "ink" }, sp(gw - strWidth(t) + 2)];
	};
	if (narrow)
		return [
			truncate([sp(at), ...glob(), { text: when, role: "dim" }], ctx.W),
			truncate(
				[
					sp(at),
					{ text: ctx.g.quote, role: "parked" },
					sp(1),
					{ text: a.why, role: "ink2", italic: true },
				],
				ctx.W,
			),
		];
	return [
		truncate(
			[
				sp(at),
				...glob(),
				...cell(when, 22, "dim"),
				sp(2),
				{ text: a.why, role: "ink2" },
			],
			ctx.W,
		),
	];
}
