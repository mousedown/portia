import type { ChildState, RunRow } from "../../core/types";
import type { Attempt, GateRun, Phase, Step, StripCell } from "./types";

export type GateKind = "task" | "exit" | "epic";

export const rowSteps = (row: RunRow): { name: string; ok: boolean }[] => {
	const steps = row.data?.steps;
	return Array.isArray(steps)
		? steps
				.filter((s) => s && typeof s.name === "string")
				.map((s) => ({ name: String(s.name), ok: s.ok === true }))
		: [];
};

export const kindOf = (row: RunRow): GateKind | undefined =>
	row.stage === "epic"
		? "epic"
		: row.stage === "gate"
			? row.data?.kind === "task"
				? "task"
				: row.data?.kind === "exit"
					? "exit"
					: undefined
			: undefined;

/**
 * The ordered union of step names over every gate of a kind, in first-seen order. A step
 * first seen in a longer gate goes in after the last step it followed.
 */
export function stepCatalog(rows: RunRow[], kind: GateKind): string[] {
	const out: string[] = [];
	for (const row of rows) {
		if (kindOf(row) !== kind) continue;
		let prev = -1;
		for (const s of rowSteps(row)) {
			const at = out.indexOf(s.name);
			if (at >= 0) prev = at;
			else {
				out.splice(prev + 1, 0, s.name);
				prev++;
			}
		}
	}
	return out;
}

export function gateRun(row: RunRow, catalog: string[]): GateRun {
	const steps = rowSteps(row);
	const named = new Map(steps.map((s) => [s.name, s.ok]));
	const all: Step[] = catalog.map((name) => ({
		name,
		ok: named.has(name) ? (named.get(name) ?? null) : null,
	}));
	for (const s of steps)
		if (!catalog.includes(s.name)) all.push({ name: s.name, ok: s.ok });
	return {
		at: row.at,
		kind: kindOf(row) ?? "exit",
		pass: row.status === "pass",
		steps: all,
	};
}

const cellsOf = (g: GateRun | undefined, n: number): StripCell[] =>
	g
		? g.steps.map((s) => ({
				kind: s.ok === true ? "pass" : s.ok === false ? "fail" : "unrun",
			}))
		: Array.from({ length: n }, () => ({ kind: "unrun" as const }));
const active = (n: number): StripCell[] =>
	Array.from({ length: n }, () => ({ kind: "active" as const }));
const GAP: StripCell = { kind: "gap" };

/** The gate strip for one child: task cells, a gap, then exit cells. */
export function strip(
	state: ChildState,
	phase: Phase | undefined,
	attempts: Attempt[],
	catalog: { task: string[]; exit: string[] },
): StripCell[] {
	const t = catalog.task.length;
	const x = catalog.exit.length;
	if (state === "pending" || state === "ready" || !attempts.length) return [];
	if (state !== "running") {
		const last = [...attempts].reverse().find((a) => a.task || a.exit);
		return [...cellsOf(last?.task, t), GAP, ...cellsOf(last?.exit, x)];
	}
	const cur = attempts.at(-1);
	let cells: StripCell[];
	if (phase === "exit gate")
		cells = [...cellsOf(cur?.task, t), GAP, ...active(x)];
	else if (phase === "reporting")
		cells = [...cellsOf(cur?.task, t), GAP, ...cellsOf(cur?.exit, x)];
	else
		cells = [
			...(cur?.task ? cellsOf(cur.task, t) : active(t)),
			GAP,
			...cellsOf(cur?.exit, x),
		];
	return cells;
}

/** `task:pass exit:fail@unit`, for piped output. */
export function gateSummary(cells: StripCell[]): string {
	if (!cells.length) return "-";
	const gap = cells.findIndex((c) => c.kind === "gap");
	const part = (name: string, cs: StripCell[]) => {
		if (!cs.length || cs.every((c) => c.kind === "unrun")) return `${name}:-`;
		if (cs.some((c) => c.kind === "active")) return `${name}:running`;
		return cs.some((c) => c.kind === "fail") ? `${name}:fail` : `${name}:pass`;
	};
	return `${part("task", cells.slice(0, gap))} ${part("exit", cells.slice(gap + 1))}`;
}

/** The same, naming the failed step: `exit:fail@unit`. */
export function gateField(
	cells: StripCell[],
	catalog: { task: string[]; exit: string[] },
): string {
	const base = gateSummary(cells);
	if (base === "-") return base;
	const gap = cells.findIndex((c) => c.kind === "gap");
	const failAt = (cs: StripCell[], names: string[]) => {
		const i = cs.findIndex((c) => c.kind === "fail");
		return i >= 0 ? `@${names[i] ?? i + 1}` : "";
	};
	const [task = "", exit = ""] = base.split(" ");
	return `${task}${task.endsWith("fail") ? failAt(cells.slice(0, gap), catalog.task) : ""} ${exit}${exit.endsWith("fail") ? failAt(cells.slice(gap + 1), catalog.exit) : ""}`;
}

export const failedStep = (g: GateRun): string | undefined =>
	g.steps.find((s) => s.ok === false)?.name;

const SHORT: Record<string, string> = {
	typecheck: "type",
	integration: "intg",
	acceptance: "acpt",
	infrastructure: "infr",
	moderation: "modr",
	"related-unit": "rel-u",
};

/** A step's label in at most five cells, for narrow layouts and column heads. */
export const shortStep = (name: string) =>
	name.length <= 5 ? name : (SHORT[name] ?? name.slice(0, 4));
