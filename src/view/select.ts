import { ms } from "./model/format";
import { GROUPS } from "./model/home";
import type {
	Attempt,
	ChildView,
	Event,
	GateRun,
	HomeView,
	RunView,
} from "./model/types";
import type { ViewState } from "./runtime/state";

export interface Term {
	kind: "state" | "wave" | "model" | "live" | "quiet" | "text";
	value: string;
}

export function parseFilter(text: string): Term[] {
	return text
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => {
			const m = /^(state|wave|model):(.+)$/i.exec(w);
			if (m)
				return {
					kind: (m[1] ?? "").toLowerCase() as Term["kind"],
					value: (m[2] ?? "").toLowerCase(),
				};
			if (w === "live") return { kind: "live", value: "" };
			if (w === "quiet") return { kind: "quiet", value: "" };
			return { kind: "text", value: w.toLowerCase() };
		});
}

/** The indices of `needle` in `hay` as a case-insensitive subsequence, or undefined. */
export function subsequence(hay: string, needle: string): number[] | undefined {
	const h = hay.toLowerCase();
	const out: number[] = [];
	let i = 0;
	for (const ch of needle.toLowerCase()) {
		const at = h.indexOf(ch, i);
		if (at < 0) return undefined;
		out.push(at);
		i = at + 1;
	}
	return out;
}

const modelOf = (c: ChildView) =>
	`${c.model?.requested ?? ""} ${c.model?.actual ?? ""}`.toLowerCase();

function childTerm(t: Term, run: RunView, c: ChildView): boolean {
	switch (t.kind) {
		case "state":
			return (
				c.state === t.value ||
				run.group === t.value ||
				(t.value === "quiet" && c.phase === "quiet")
			);
		case "wave":
			return String(c.wave) === t.value;
		case "model":
			return modelOf(c).includes(t.value);
		case "live":
			return c.state === "running" && c.phase !== "quiet";
		case "quiet":
			return c.phase === "quiet";
		default:
			return !!subsequence(`${c.key} ${c.summary}`, t.value);
	}
}

function runTerm(t: Term, run: RunView): boolean {
	if (t.kind === "state" && run.group === t.value) return true;
	if (t.kind === "live") return run.group === "session";
	if (
		t.kind === "text" &&
		subsequence(`${run.key} ${run.summary ?? ""}`, t.value)
	)
		return true;
	return run.children.some((c) => childTerm(t, run, c));
}

/** Words of one kind are alternatives; different kinds must all hold. */
function all(terms: Term[], test: (t: Term) => boolean): boolean {
	const kinds = new Map<string, Term[]>();
	for (const t of terms) kinds.set(t.kind, [...(kinds.get(t.kind) ?? []), t]);
	return [...kinds.values()].every((ts) => ts.some(test));
}

export const matchRun = (run: RunView, terms: Term[]) =>
	all(terms, (t) => runTerm(t, run));
export const matchChild = (run: RunView, c: ChildView, terms: Term[]) =>
	all(
		terms,
		(t) =>
			(t.kind === "state" && run.group === t.value) || childTerm(t, run, c),
	);

const terms = (state: ViewState): Term[] =>
	state.filter?.text ? parseFilter(state.filter.text) : [];

export function homeRuns(home: HomeView, state: ViewState): RunView[] {
	const t = terms(state);
	const runs = t.length ? home.runs.filter((r) => matchRun(r, t)) : home.runs;
	return GROUPS.flatMap((g) => runs.filter((r) => r.group === g));
}

export const ACTIVITY_CAP = 500;

/** Newest first; each time parsed once, not once per comparison. */
function newestFirst(events: Event[]): Event[] {
	return events
		.map((e) => ({ e, t: ms(e.at) }))
		.sort((a, b) => b.t - a.t || b.e.id.localeCompare(a.e.id))
		.map((x) => x.e);
}

/**
 * A run's events newest first, kept per events array: the loop reuses a run's view
 * while its files are unchanged, so a long log is sorted once, not once a frame.
 */
const sortedRuns = new WeakMap<Event[], Event[]>();
function sortedEvents(run: RunView): Event[] {
	let s = sortedRuns.get(run.events);
	if (!s) {
		s = newestFirst(run.events);
		sortedRuns.set(run.events, s);
	}
	return s;
}

export function activityEvents(home: HomeView, state: ViewState): Event[] {
	const t = terms(state);
	const runs = home.runs.filter((r) => !t.length || matchRun(r, t));
	const lists = runs.map((r) =>
		sortedEvents(r).filter((e) => {
			if (!t.length) return true;
			const c = r.children.find((x) => x.key === e.child);
			return !c || matchChild(r, c, t);
		}),
	);
	// Each list is already newest first: merge the heads, stopping at the cap.
	if (lists.length === 1) return (lists[0] ?? []).slice(0, ACTIVITY_CAP);
	const out: Event[] = [];
	const at = lists.map(() => 0);
	while (out.length < ACTIVITY_CAP) {
		let best = -1;
		let bt = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < lists.length; i++) {
			const e = lists[i]?.[at[i] ?? 0];
			if (!e) continue;
			const et = ms(e.at);
			const b = best >= 0 ? lists[best]?.[at[best] ?? 0] : undefined;
			if (
				best < 0 ||
				et > bt ||
				(et === bt && b !== undefined && e.id.localeCompare(b.id) > 0)
			) {
				best = i;
				bt = et;
			}
		}
		if (best < 0) break;
		const e = lists[best]?.[at[best] ?? 0];
		if (e) out.push(e);
		at[best] = (at[best] ?? 0) + 1;
	}
	return out;
}

export function runChildren(run: RunView, state: ViewState): ChildView[] {
	const t = terms(state);
	return t.length
		? run.children.filter((c) => matchChild(run, c, t))
		: run.children;
}

export const gateChildren = (run: RunView, state: ViewState): ChildView[] =>
	runChildren(run, state).filter(
		(c) => c.state === "running" || c.attempts.some((a) => a.task || a.exit),
	);

/** The ids a child's Evidence section lists: each requirement, then anything else it reported. */
export function evidenceIds(c: ChildView): string[] {
	const ids = c.requirements.map((q) => q.id);
	const extra = [
		...Object.keys(c.evidence),
		...Object.keys(c.unlandedEvidence?.evidence ?? {}),
	];
	for (const id of extra) if (!ids.includes(id)) ids.push(id);
	return ids;
}

/** The newest gate of a kind, with the attempt it ran in and how long it took. */
export function lastGate(
	c: ChildView,
	kind: "task" | "exit",
	skipCurrent = false,
): { gate: GateRun; attempt: Attempt; ms?: number } | undefined {
	const list = [...c.attempts].reverse();
	for (const a of skipCurrent ? list.slice(1) : list) {
		const gate = a[kind];
		if (!gate) continue;
		const e = a.events.find((x) => x.row.stage === "gate" && x.at === gate.at);
		return { gate, attempt: a, ms: e?.durationMs };
	}
	return undefined;
}

/** Why a gate failed, from the rows after it in its attempt: a land failure or a result. */
export function failureText(a: Attempt, gate: GateRun): string | undefined {
	const after = a.events.filter((e) => e.at >= gate.at);
	const e = after.find(
		(x) =>
			(x.row.stage === "land" && x.row.status !== "landed") ||
			(x.row.stage === "result" && x.row.status !== "done"),
	);
	if (!e) return undefined;
	return [e.phrase.detail, e.phrase.fold].filter(Boolean).join("\n");
}

/**
 * The gates the Child page shows, in order: the last task gate, then the exit gate that
 * is running and the one before it, or the last exit gate.
 */
export function shownGates(
	c: ChildView,
): { kind: "task" | "exit"; g?: ReturnType<typeof lastGate> }[] {
	const out: { kind: "task" | "exit"; g?: ReturnType<typeof lastGate> }[] = [];
	const task = lastGate(c, "task");
	if (task) out.push({ kind: "task", g: task });
	if (c.state === "running" && c.phase === "exit gate") {
		out.push({ kind: "exit" });
		const prev = lastGate(c, "exit", c.attempts.at(-1)?.exit === undefined);
		if (prev) out.push({ kind: "exit", g: prev });
	} else {
		const exit = lastGate(c, "exit");
		if (exit) out.push({ kind: "exit", g: exit });
	}
	return out;
}

export const gateItem = (c: ChildView, kind: string, attempt: number) =>
	`gate:${c.key}:${kind}:${attempt}`;

/** The gate rows the cursor visits: each failure with a reason to read. */
export function gateIds(c: ChildView): string[] {
	return shownGates(c)
		.filter((x) => x.g && !x.g.gate.pass && failureText(x.g.attempt, x.g.gate))
		.map((x) => gateItem(c, x.kind, x.g?.attempt.n ?? 0));
}

/**
 * The child's worktree, and when it was removed: an env torn down whose worktree has
 * gone from the disk has nothing left to copy or open.
 */
export function worktreeOf(c: ChildView): {
	path?: string;
	removedAt?: string;
} {
	const path = c.env?.worktree || c.worker?.worktree || undefined;
	if (path && c.env && !c.env.up && c.env.exists === false)
		return { path, removedAt: c.env.since };
	return { path };
}

export const evItem = (c: ChildView, id: string) => `ev:${c.key}:${id}`;
export const attemptItem = (c: ChildView, n: number) => `att:${c.key}:${n}`;
export const workerItem = (c: ChildView) => `worker:${c.key}`;
export const phaseItem = (c: ChildView) => `phase:${c.key}`;

/** The newest attempt starts open and the rest closed; ⏎ flips one. */
export function attemptOpen(
	state: ViewState,
	c: ChildView,
	n: number,
): boolean {
	const current = c.attempts.at(-1)?.n === n;
	return current !== state.expanded.includes(attemptItem(c, n));
}

/** The rows the cursor visits on the Child page, in page order. */
export function childItems(c: ChildView, state: ViewState): string[] {
	const out = evidenceIds(c).map((id) => evItem(c, id));
	out.push(...gateIds(c));
	if (c.worker) out.push(workerItem(c));
	for (const a of [...c.attempts].reverse()) {
		out.push(attemptItem(c, a.n));
		if (!attemptOpen(state, c, a.n)) continue;
		for (const e of a.events) out.push(e.id);
		if (a.outcome === "running") out.push(phaseItem(c));
	}
	return out;
}

export function childOf(
	home: HomeView,
	run?: string,
	child?: string,
): { run?: RunView; child?: ChildView } {
	const r = home.runs.find((x) => x.key === run);
	return { run: r, child: r?.children.find((c) => c.key === child) };
}

/** Where a run's lists open with nothing remembered: the child that needs attention first. */
export function attentionChild(
	children: ChildView[],
	ids: string[],
): string | undefined {
	const live = children.filter((c) => ids.includes(c.key));
	const order: ((c: ChildView) => boolean)[] = [
		(c) => c.wait?.kind === "question",
		(c) => c.state === "running" && c.phase !== "quiet",
		(c) => c.state === "parked",
		(c) => c.state === "failed",
		(c) => c.state === "running",
		(c) => c.state === "ready",
	];
	for (const test of order) {
		const c = live.find(test);
		if (c) return c.key;
	}
	return undefined;
}

/** The list the cursor is on: its id in the selection map and the ids it can visit. */
export function currentList(
	state: ViewState,
	home: HomeView,
	_now: number,
): { list: string; ids: string[]; def?: string } {
	switch (state.screen) {
		case "home":
			return {
				list: "home:runs",
				ids: homeRuns(home, state).map((r) => r.key),
			};
		case "activity":
			return {
				list: "activity",
				ids: activityEvents(home, state).map((e) => e.id),
			};
		case "machine":
		case "worker":
			return { list: state.screen, ids: [] };
	}
	const run = home.runs.find((r) => r.key === state.runKey);
	if (!run) return { list: "none", ids: [] };
	if (state.screen === "child") {
		const c = run.children.find((x) => x.key === state.childKey);
		return {
			list: `child:${run.key}:${state.childKey}`,
			ids: c ? childItems(c, state) : [],
		};
	}
	const kids = state.matrix
		? gateChildren(run, state)
		: runChildren(run, state);
	const ids = kids.map((c) => c.key);
	return {
		list: `run:${run.key}:${state.matrix ? "gates" : "children"}`,
		ids,
		def: attentionChild(run.children, ids),
	};
}

/** The selected id on a list: the remembered one while it is still there, else the first. */
export function selectedId(
	state: ViewState,
	list: string,
	ids: string[],
	def?: string,
): string | undefined {
	const s = state.selection[list];
	return s !== undefined && ids.includes(s) ? s : (def ?? ids[0]);
}
