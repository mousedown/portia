import { hhmm } from "../model/format";
import type { ChildView, HomeView, Role, RunView, Sort } from "../model/types";
import {
	childOf,
	currentList,
	selectedId,
	worktreeOf as treeOf,
} from "../select";
import type { Key } from "./keys";

/**
 * One stack of pages: Home › Run › Child › Worker, with Activity and Machine beside Home.
 * → or ⏎ goes down a page, ← or esc comes back up; there are no tabs.
 */
export type Screen =
	| "home"
	| "activity"
	| "machine"
	| "run"
	| "child"
	| "worker";
export const SORTS: Sort[] = ["activity", "key", "tokens"];

/** A page left by going down from it: ← and esc come back to it, as it was. */
export interface Place {
	screen: Screen;
	runKey?: string;
	childKey?: string;
	matrix: boolean;
}

export interface ViewState {
	screen: Screen;
	runKey?: string;
	childKey?: string;
	/** The Run page shows the gate matrix instead of the children list. */
	matrix: boolean;
	/** The pages gone down from, newest last; their selection and scroll are kept by list. */
	stack: Place[];
	/** list id → the selected item's id: selection follows a key, never a row index. */
	selection: Record<string, string>;
	scroll: Record<string, number>;
	filter?: { text: string; editing: boolean };
	command?: { text: string; hist: number };
	/** The answer being typed to a parked child, and the question it was typed against. */
	answer?: { run: string; child: string; since: string; text: string };
	history: string[];
	overlay?: "help";
	toast?: { text: string; role: Role; until: number };
	sort: Sort;
	/** Activity follows new rows. */
	follow: boolean;
	/** How many activity rows there were when following paused. */
	pausedAt?: number;
	/** The Worker page keeps to the end of the log as it grows. */
	tail: boolean;
	/** The Worker page's search: which match the view is on, counted from the first; none is the newest. */
	match?: number;
	motion: boolean;
	theme: "auto" | "dark" | "light";
	ascii?: boolean;
	/** Expanded items: evidence, attempts (the current one starts open), folds. */
	expanded: string[];
	flashes: Record<string, number>;
	refreshedAt?: number;
	/** A run `x` was pressed on once: a second `x` before `until` archives it. */
	armed?: { run: string; until: number };
}

export const initialState = (o: Partial<ViewState> = {}): ViewState => ({
	screen: "home",
	matrix: false,
	stack: [],
	selection: {},
	scroll: {},
	history: [],
	sort: "activity",
	follow: true,
	tail: true,
	motion: true,
	theme: "auto",
	expanded: [],
	flashes: {},
	...o,
});

export type Effect =
	| { kind: "quit" }
	| { kind: "suspend" }
	| { kind: "open"; run: string; pr: number }
	| { kind: "copy"; text: string; what: string }
	| { kind: "pager"; path?: string; text?: string }
	| { kind: "editor"; path: string }
	| { kind: "launch"; key: string; prompt: string; run?: string }
	| { kind: "refresh" }
	| { kind: "theme" }
	| { kind: "archive"; run: string }
	| { kind: "answer"; run: string; child: string; since: string; text: string };

export interface ReduceCtx {
	home: HomeView;
	now: number;
	rows: number;
}
export interface Reduced {
	state: ViewState;
	effects: Effect[];
}

const TOAST_MS = 3000;
export const COMMANDS = [
	"run",
	"child",
	"open",
	"new",
	"sort",
	"theme",
	"motion",
	"ascii",
	"refresh",
	"help",
	"q",
];

const toast = (
	s: ViewState,
	text: string,
	now: number,
	role: Role = "ink2",
): ViewState => ({
	...s,
	toast: { text, role, until: now + TOAST_MS },
});

function move(
	s: ViewState,
	ctx: ReduceCtx,
	by: number | "top" | "bottom",
): ViewState {
	const { list, ids, def } = currentList(s, ctx.home, ctx.now);
	if (!ids.length) return s;
	const cur = selectedId(s, list, ids, def);
	const i = cur === undefined ? 0 : ids.indexOf(cur);
	const next =
		by === "top"
			? 0
			: by === "bottom"
				? ids.length - 1
				: Math.min(ids.length - 1, Math.max(0, i + by));
	const id = ids[next];
	return id === undefined
		? s
		: { ...s, selection: { ...s.selection, [list]: id } };
}

const runOf = (ctx: ReduceCtx, key?: string): RunView | undefined =>
	ctx.home.runs.find((r) => r.key === key);

function selected(s: ViewState, ctx: ReduceCtx): string | undefined {
	const { list, ids, def } = currentList(s, ctx.home, ctx.now);
	return selectedId(s, list, ids, def);
}

/** The run, and the child when there is one, that the page or its selected row stands for. */
function selectedChild(
	s: ViewState,
	ctx: ReduceCtx,
): { run?: RunView; child?: ChildView } {
	const id = selected(s, ctx);
	if (s.screen === "home") return { run: runOf(ctx, id) };
	if (s.screen === "activity") {
		const [run] = (id ?? "").split(":");
		const r = runOf(ctx, run);
		const e = r?.events.find((x) => x.id === id);
		return { run: r, child: r?.children.find((c) => c.key === e?.child) };
	}
	if (s.screen === "machine") return {};
	const run = runOf(ctx, s.runKey);
	const key = s.screen === "run" ? id : s.childKey;
	return { run, child: run?.children.find((c) => c.key === key) };
}

/** How long the first `x` waits for the second. */
const ARM_MS = 3000;

/**
 * `x` on Home, twice: archives the selected run, which moves its directory to
 * `runs/.archive/`, out of the view. Only a run at rest or delivered: nothing that is
 * working or waits on a person.
 */
function archiveKey(s: ViewState, ctx: ReduceCtx): Reduced {
	const { run } = selectedChild(s, ctx);
	if (!run) return { state: s, effects: [] };
	if (run.group !== "rest" && run.group !== "delivered")
		return {
			state: toast(
				s,
				`${run.key} is not done: only a run at rest or delivered can be archived`,
				ctx.now,
				"dim",
			),
			effects: [],
		};
	if (s.armed?.run === run.key && ctx.now < s.armed.until)
		return {
			state: { ...s, armed: undefined, toast: undefined },
			effects: [{ kind: "archive", run: run.key }],
		};
	return {
		state: {
			...toast(
				s,
				`x again to archive ${run.key} · it moves to runs/.archive`,
				ctx.now,
				"ink2",
			),
			armed: { run: run.key, until: ctx.now + ARM_MS },
		},
		effects: [],
	};
}

const STACK_MAX = 32;

/** Where the page is now, to come back to. */
const placeOf = (s: ViewState): Place => ({
	screen: s.screen,
	runKey: s.runKey,
	childKey: s.childKey,
	matrix: s.matrix,
});

/** Goes to another page, remembering this one for ← and esc. */
function go(s: ViewState, next: ViewState): ViewState {
	const here = placeOf(s);
	const there = placeOf(next);
	if (JSON.stringify(here) === JSON.stringify(there)) return next;
	return { ...next, stack: [...s.stack, here].slice(-STACK_MAX) };
}

function openRun(s: ViewState, key: string): ViewState {
	return {
		...s,
		screen: "run",
		runKey: key,
		childKey: undefined,
		matrix: false,
		filter: undefined,
		selection: { ...s.selection, "home:runs": key },
	};
}

function openChild(s: ViewState, run: string, child: string): ViewState {
	const base =
		(s.screen === "child" || s.screen === "worker") && s.runKey === run
			? s
			: openRun(s, run);
	const list = `run:${run}:${base.matrix ? "gates" : "children"}`;
	return {
		...base,
		screen: "child",
		childKey: child,
		filter: undefined,
		selection: { ...base.selection, [list]: child },
	};
}

function openWorker(s: ViewState, ctx: ReduceCtx): Reduced {
	const { child } = selectedChild(s, ctx);
	if (!child?.worker)
		return {
			state: toast(s, "not dispatched yet: no worker to show", ctx.now, "dim"),
			effects: [],
		};
	if (child.worker.kind === "subagent")
		return {
			state: toast(
				s,
				"a subagent has no log of its own: it runs inside the orchestrator's session",
				ctx.now,
				"dim",
			),
			effects: [],
		};
	return {
		state: go(s, {
			...s,
			screen: "worker",
			filter: undefined,
			tail: true,
			match: undefined,
		}),
		effects: [],
	};
}

function prOf(s: ViewState, ctx: ReduceCtx): Effect[] | string {
	const { run, child } = selectedChild(s, ctx);
	if (!run) return "no run selected";
	if (child) {
		if (child.pr) return [{ kind: "open", run: run.key, pr: child.pr }];
		return run.epicPr
			? `${child.key} has no PR yet · :open ${run.key} opens the epic PR #${run.epicPr}`
			: `${child.key} has no PR yet`;
	}
	return run.epicPr
		? [{ kind: "open", run: run.key, pr: run.epicPr }]
		: `${run.key} has no epic PR yet`;
}

function withEffects(s: ViewState, r: Effect[] | string, now: number): Reduced {
	return typeof r === "string"
		? { state: toast(s, r, now, "dim"), effects: [] }
		: { state: s, effects: r };
}

/** The worktree of the child a page stands for, or why there is none to open. */
function worktreeOf(
	s: ViewState,
	ctx: ReduceCtx,
): { path: string } | { none: string } {
	const { child } = selectedChild(s, ctx);
	const t = child ? treeOf(child) : {};
	if (!t.path) return { none: "no worktree recorded for this child" };
	if (t.removedAt !== undefined)
		return {
			none: `the worktree was removed${t.removedAt ? ` at ${hhmm(t.removedAt)}` : ""}`,
		};
	return { path: t.path };
}

function back(s: ViewState): ViewState {
	if (s.overlay) return { ...s, overlay: undefined };
	if (s.filter?.text && s.screen !== "child")
		return { ...s, filter: undefined, match: undefined };
	const prev = s.stack.at(-1);
	if (prev)
		return {
			...s,
			...prev,
			stack: s.stack.slice(0, -1),
			filter: undefined,
			match: undefined,
		};
	switch (s.screen) {
		case "worker":
			return { ...s, screen: "child", match: undefined };
		case "child":
			return { ...s, screen: "run", childKey: undefined };
		case "run":
		case "activity":
		case "machine":
			return { ...s, screen: "home" };
		default:
			return s;
	}
}

/**
 * → goes down a page. ⏎ does too, except where it unfolds what the cursor is on: an
 * Activity row opens in place, and a Child page's rows open in place.
 */
function enter(s: ViewState, ctx: ReduceCtx, open: boolean): Reduced {
	const none = { state: s, effects: [] };
	const st = (state: ViewState) => ({ state, effects: [] });
	const id = selected(s, ctx);
	if (id === undefined) return none;
	switch (s.screen) {
		case "home":
			return st(go(s, openRun(s, id)));
		case "activity": {
			if (!open) return st(toggle(s, id));
			const { run, child } = selectedChild(s, ctx);
			if (!run) return none;
			return st(
				go(s, child ? openChild(s, run.key, child.key) : openRun(s, run.key)),
			);
		}
		case "run": {
			const { run, child } = selectedChild(s, ctx);
			return run && child ? st(go(s, openChild(s, run.key, child.key))) : none;
		}
		case "child": {
			if (id.startsWith("worker:")) return openWorker(s, ctx);
			if (
				id.startsWith("ev:") ||
				id.startsWith("att:") ||
				id.startsWith("gate:")
			)
				return st(toggle(s, id));
			const run = runOf(ctx, s.runKey);
			const e = run?.events.find((x) => x.id === id);
			if (!e?.phrase.fold) return none;
			if (!s.expanded.includes(id)) return st(toggle(s, id));
			return {
				state: s,
				effects: [
					{ kind: "pager", text: `${e.phrase.detail}\n${e.phrase.fold}\n` },
				],
			};
		}
		default:
			return none;
	}
}

const toggle = (s: ViewState, id: string): ViewState => ({
	...s,
	expanded: s.expanded.includes(id)
		? s.expanded.filter((x) => x !== id)
		: [...s.expanded, id],
});

/** The Run page between its children list and its gate matrix, keeping the selected child. */
function flipMatrix(s: ViewState): ViewState {
	const from = `run:${s.runKey}:${s.matrix ? "gates" : "children"}`;
	const to = `run:${s.runKey}:${s.matrix ? "children" : "gates"}`;
	const keep = s.selection[from];
	return {
		...s,
		matrix: !s.matrix,
		selection: keep ? { ...s.selection, [to]: keep } : s.selection,
	};
}

/** The scroll offset a page without a list moves by. */
function scrollBy(
	s: ViewState,
	key: string,
	by: number,
	o: Partial<ViewState> = {},
): ViewState {
	const at = Math.max(0, (s.scroll[key] ?? 0) + by);
	return { ...s, ...o, scroll: { ...s.scroll, [key]: at } };
}

export const workerScrollKey = (s: ViewState) =>
	`worker:${s.runKey}:${s.childKey}`;

/** Any unique prefix of a command name; `q` is its own. */
export function resolveCommand(word: string): string | string[] {
	const w = word.toLowerCase();
	if (COMMANDS.includes(w)) return w;
	if (w === "quit") return "q";
	const hits = COMMANDS.filter((c) => c.startsWith(w));
	return hits.length === 1 ? (hits[0] ?? "") : hits;
}

/** Run keys, or a unique key suffix (`410` for `ACME-410`). */
export function findKey(keys: string[], want: string): string | string[] {
	const w = want.toUpperCase();
	if (keys.includes(w)) return w;
	const hits = keys.filter((k) => k.endsWith(w) || k.endsWith(`-${w}`));
	return hits.length === 1 ? (hits[0] ?? "") : hits;
}

/** The candidates for the word being typed, for the ghost and the candidate list. */
export function completions(
	text: string,
	home: HomeView,
	runKey?: string,
): string[] {
	const [cmd = "", ...rest] = text.split(" ");
	if (!rest.length)
		return COMMANDS.filter((c) => c.startsWith(cmd.toLowerCase()));
	const name = resolveCommand(cmd);
	const arg = (rest.at(-1) ?? "").toUpperCase();
	const pick = (keys: string[]) =>
		keys.filter((k) => k.startsWith(arg) || k.includes(arg));
	switch (name) {
		case "run":
			return pick(home.runs.map((r) => r.key));
		case "child":
		case "open": {
			const here =
				home.runs.find((r) => r.key === runKey)?.children.map((c) => c.key) ??
				[];
			const all = home.runs.flatMap((r) => r.children.map((c) => c.key));
			return pick([
				...new Set([
					...here,
					...all,
					...(name === "open" ? home.runs.map((r) => r.key) : []),
				]),
			]);
		}
		case "new":
			return pick(
				home.runs
					.filter(
						(r) =>
							r.group === "waiting" ||
							r.group === "judgement" ||
							r.group === "rest",
					)
					.map((r) => r.key),
			);
		case "sort":
			return ["activity", "key", "tokens"].filter((x) =>
				x.startsWith(arg.toLowerCase()),
			);
		case "theme":
			return ["auto", "dark", "light"].filter((x) =>
				x.startsWith(arg.toLowerCase()),
			);
		case "motion":
		case "ascii":
			return ["on", "off"].filter((x) => x.startsWith(arg.toLowerCase()));
		default:
			return [];
	}
}

function complete(text: string, home: HomeView, runKey?: string): string {
	const words = text.split(" ");
	const cands = completions(text, home, runKey);
	if (!cands.length) return text;
	let common = cands[0] ?? "";
	for (const c of cands)
		while (!c.startsWith(common)) common = common.slice(0, -1);
	const cur = words.at(-1) ?? "";
	if (common.length <= cur.length) return text;
	words[words.length - 1] = common;
	return words.join(" ") + (cands.length === 1 ? " " : "");
}

function runCommand(s: ViewState, ctx: ReduceCtx, text: string): Reduced {
	const [word = "", ...args] = text.trim().split(/\s+/);
	const fail = (msg: string) => ({
		state: toast(s, msg, ctx.now, "failed"),
		effects: [] as Effect[],
	});
	if (!word) return { state: s, effects: [] };
	const name = resolveCommand(word);
	if (Array.isArray(name))
		return fail(
			name.length
				? `ambiguous command: ${word} (${name.join(", ")})`
				: `unknown command: ${word}   (try :help)`,
		);
	const arg = args[0];
	switch (name) {
		case "q":
			return { state: s, effects: [{ kind: "quit" }] };
		case "help":
			return { state: { ...s, overlay: "help" }, effects: [] };
		case "refresh":
			return { state: s, effects: [{ kind: "refresh" }] };
		case "sort": {
			const v =
				arg && ["activity", "key", "tokens"].find((x) => x.startsWith(arg));
			return v
				? { state: { ...s, sort: v as Sort }, effects: [] }
				: fail("usage: :sort activity|key|tokens");
		}
		case "theme": {
			const v = arg && ["auto", "dark", "light"].find((x) => x.startsWith(arg));
			return v
				? {
						state: { ...s, theme: v as ViewState["theme"] },
						effects: [{ kind: "theme" }],
					}
				: fail("usage: :theme auto|dark|light");
		}
		case "motion":
		case "ascii": {
			if (arg !== "on" && arg !== "off") return fail(`usage: :${name} on|off`);
			return {
				state:
					name === "motion"
						? { ...s, motion: arg === "on" }
						: { ...s, ascii: arg === "on" },
				effects: [],
			};
		}
		case "new": {
			const key = arg?.toUpperCase();
			if (!key || !/^[A-Z][A-Z0-9]*-\d+$/.test(key))
				return fail("usage: :new KEY   (an epic or story, e.g. PROJ-123)");
			const run = runOf(ctx, key);
			if (run?.group === "session") return fail(`${key} is already in session`);
			if (run?.group === "delivered")
				return fail(`${key} is already delivered`);
			return {
				state: s,
				effects: [
					run
						? { kind: "launch", key, prompt: `/portia resume ${key}`, run: key }
						: { kind: "launch", key, prompt: `/portia ${key}` },
				],
			};
		}
		case "run": {
			if (!arg) return fail("usage: :run KEY");
			const k = findKey(
				ctx.home.runs.map((r) => r.key),
				arg,
			);
			return typeof k === "string"
				? { state: go(s, openRun(s, k)), effects: [] }
				: fail(`no run matches ${arg}`);
		}
		case "child": {
			if (!arg) return fail("usage: :child KEY");
			const here = runOf(ctx, s.runKey);
			const pools = [here ? [here] : [], ctx.home.runs];
			for (const pool of pools) {
				const pairs = pool.flatMap((r) =>
					r.children.map((c) => [r.key, c.key] as const),
				);
				const k = findKey(
					pairs.map((p) => p[1]),
					arg,
				);
				if (typeof k === "string") {
					const run = pairs.find((p) => p[1] === k)?.[0] ?? "";
					return { state: go(s, openChild(s, run, k)), effects: [] };
				}
			}
			return fail(`no child matches ${arg}`);
		}
		case "open": {
			if (!arg) return withEffects(s, prOf(s, ctx), ctx.now);
			const run = runOf(
				ctx,
				findKey(
					ctx.home.runs.map((r) => r.key),
					arg,
				) as string,
			);
			if (run)
				return withEffects(
					s,
					run.epicPr
						? [{ kind: "open", run: run.key, pr: run.epicPr }]
						: `${run.key} has no epic PR yet`,
					ctx.now,
				);
			for (const r of ctx.home.runs) {
				const k = findKey(
					r.children.map((c) => c.key),
					arg,
				);
				const c =
					typeof k === "string"
						? r.children.find((x) => x.key === k)
						: undefined;
				if (c)
					return withEffects(
						s,
						c.pr
							? [{ kind: "open", run: r.key, pr: c.pr }]
							: `${c.key} has no PR yet`,
						ctx.now,
					);
			}
			return fail(`nothing matches ${arg}`);
		}
		default:
			return fail(`unknown command: ${word}   (try :help)`);
	}
}

function editCommand(s: ViewState, k: Key, ctx: ReduceCtx): Reduced {
	const cmd = s.command ?? { text: "", hist: -1 };
	const set = (text: string, hist = -1) => ({
		state: { ...s, command: { text, hist } },
		effects: [],
	});
	switch (k.name) {
		case "esc":
			return { state: { ...s, command: undefined }, effects: [] };
		case "enter": {
			const text = cmd.text.trim();
			const next: ViewState = {
				...s,
				command: undefined,
				history: text
					? [...s.history.filter((h) => h !== text), text]
					: s.history,
			};
			return runCommand(next, ctx, text);
		}
		case "backspace":
			return cmd.text
				? set(cmd.text.slice(0, -1))
				: { state: { ...s, command: undefined }, effects: [] };
		case "tab":
			return set(complete(cmd.text, ctx.home, s.runKey));
		case "up": {
			if (!s.history.length) return { state: s, effects: [] };
			const h = cmd.hist < 0 ? s.history.length - 1 : Math.max(0, cmd.hist - 1);
			return set(s.history[h] ?? "", h);
		}
		case "down": {
			if (cmd.hist < 0) return { state: s, effects: [] };
			const h = cmd.hist + 1;
			return h >= s.history.length ? set("") : set(s.history[h] ?? "", h);
		}
		case "char":
			return set(cmd.text + (k.ch ?? ""));
		case "paste":
			return set(cmd.text + (k.text ?? "").replace(/\s+/g, " "));
		default:
			return { state: s, effects: [] };
	}
}

function editFilter(s: ViewState, k: Key, ctx: ReduceCtx): Reduced {
	const f = s.filter ?? { text: "", editing: true };
	const set = (text: string) => ({
		state: { ...s, filter: { text, editing: true } },
		effects: [],
	});
	switch (k.name) {
		case "esc":
			return { state: { ...s, filter: undefined }, effects: [] };
		case "enter":
			return {
				state: {
					...s,
					filter: f.text.trim() ? { text: f.text, editing: false } : undefined,
				},
				effects: [],
			};
		case "backspace":
			return set(f.text.slice(0, -1));
		case "char":
			return set(f.text + (k.ch ?? ""));
		case "paste":
			return set(f.text + (k.text ?? "").replace(/\s+/g, " "));
		case "up":
		case "down":
			return { state: move(s, ctx, k.name === "up" ? -1 : 1), effects: [] };
		default:
			return { state: s, effects: [] };
	}
}

const half = (ctx: ReduceCtx) => Math.max(1, Math.floor((ctx.rows - 8) / 2));

/** A cursor key as a number of rows, for pages that scroll instead of selecting. */
function scrollKey(k: Key, ctx: ReduceCtx): number | "top" | "bottom" | 0 {
	const ch = k.name === "char" ? k.ch : undefined;
	if (k.name === "up" || ch === "k") return -1;
	if (k.name === "down" || ch === "j") return 1;
	if (k.name === "^d" || k.name === "pgdn") return half(ctx);
	if (k.name === "^u" || k.name === "pgup") return -half(ctx);
	if (k.name === "home") return "top";
	if (k.name === "end") return "bottom";
	return 0;
}

/** The question that has waited longest for the person, across every run. */
function nextQuestion(home: HomeView) {
	return home.runs
		.flatMap((r) =>
			r.children.flatMap((c) =>
				c.wait?.kind === "question" && !c.wait.claim
					? [{ run: r.key, child: c.key, since: c.wait.at }]
					: [],
			),
		)
		.sort((a, b) => a.since.localeCompare(b.since))[0];
}

/** A paste as plain answer text: one newline style, and no control characters but tab. */
const cleanPaste = (t: string) =>
	t
		.replace(/\r\n?/g, "\n")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

function editAnswer(s: ViewState, k: Key): Reduced {
	const a = s.answer;
	if (!a) return { state: s, effects: [] };
	const set = (text: string): Reduced => ({
		state: { ...s, answer: { ...a, text } },
		effects: [],
	});
	switch (k.name) {
		case "esc":
			return { state: { ...s, answer: undefined }, effects: [] };
		case "enter": {
			const text = a.text.trim();
			return text
				? {
						state: s,
						effects: [
							{
								kind: "answer",
								run: a.run,
								child: a.child,
								since: a.since,
								text,
							},
						],
					}
				: { state: s, effects: [] };
		}
		case "backspace":
			return set([...a.text].slice(0, -1).join(""));
		case "char":
			return set(a.text + (k.ch ?? ""));
		case "paste":
			return set(a.text + cleanPaste(k.text ?? ""));
		default:
			return { state: s, effects: [] };
	}
}

export function reduce(prev: ViewState, k: Key, ctx: ReduceCtx): Reduced {
	// A toast lasts until the next key: whatever the key does next, it has been read.
	const s = prev.toast ? { ...prev, toast: undefined } : prev;
	const none = { state: s, effects: [] as Effect[] };
	if (k.name === "^c") return { state: s, effects: [{ kind: "quit" }] };
	// Raw mode turns off ISIG, so ^z arrives as a key and the view suspends itself.
	if (k.name === "^z") return { state: s, effects: [{ kind: "suspend" }] };
	if (s.command) return editCommand(s, k, ctx);
	if (s.answer) return editAnswer(s, k);
	if (s.filter?.editing) return editFilter(s, k, ctx);
	if (s.overlay === "help") {
		if (k.name === "esc" || (k.name === "char" && k.ch === "?"))
			return { state: { ...s, overlay: undefined }, effects: [] };
		if (k.name === "char" && k.ch === "q")
			return { state: s, effects: [{ kind: "quit" }] };
		return none;
	}
	const ch = k.name === "char" ? k.ch : undefined;
	const st = (state: ViewState) => ({ state, effects: [] as Effect[] });
	// Machine and Worker have no list: the cursor keys scroll them.
	if (s.screen === "machine" || s.screen === "worker") {
		const by = scrollKey(k, ctx);
		const key = s.screen === "machine" ? "machine" : workerScrollKey(s);
		if (s.screen === "worker" && by !== 0) {
			// While a search is on, the cursor keys go from match to match, as n and N do.
			if (s.filter?.text && (by === 1 || by === -1))
				return st({ ...s, tail: false, match: (s.match ?? -1) + by });
			if (by === "bottom") return st({ ...s, tail: true, match: undefined });
			if (by === "top")
				return st({ ...s, tail: false, scroll: { ...s.scroll, [key]: 0 } });
			// Following, a move down stays at the end; any other move pauses, and the loop
			// follows again once a move lands on the last row (settleTail).
			if (s.tail && typeof by === "number" && by > 0) return none;
			return st(scrollBy(s, key, by, { tail: false }));
		}
		if (by === "top") return st({ ...s, scroll: { ...s.scroll, [key]: 0 } });
		if (by === "bottom") return st(scrollBy(s, key, 1_000_000));
		if (by) return st(scrollBy(s, key, by));
	} else {
		if (k.name === "up" || ch === "k") return st(move(s, ctx, -1));
		if (k.name === "down" || ch === "j") return st(move(s, ctx, 1));
		if (k.name === "home") return st(move(s, ctx, "top"));
		if (k.name === "end") return st(move(s, ctx, "bottom"));
		if (k.name === "^d" || k.name === "pgdn")
			return st(move(s, ctx, half(ctx)));
		if (k.name === "^u" || k.name === "pgup")
			return st(move(s, ctx, -half(ctx)));
	}
	if (k.name === "enter" || k.name === "right" || ch === "l")
		return enter(s, ctx, k.name !== "enter");
	if (
		k.name === "esc" ||
		k.name === "left" ||
		k.name === "backspace" ||
		ch === "h"
	)
		return st(back(s));
	const side =
		s.screen === "home" || s.screen === "activity" || s.screen === "machine";
	switch (ch) {
		case "/":
			return s.screen === "child" || s.screen === "machine"
				? none
				: st({
						...s,
						filter: { text: s.filter?.text ?? "", editing: true },
						match: undefined,
					});
		// Not offered anywhere: `n` opens this line for a new run, and every other command
		// has a key of its own. Kept so a habit of typing `:` still works.
		case ":":
			return st({ ...s, command: { text: "", hist: -1 } });
		case "?":
			return st({ ...s, overlay: "help" });
		case "q":
			return { state: s, effects: [{ kind: "quit" }] };
		case "Q": {
			const q = nextQuestion(ctx.home);
			if (!q) return st(toast(s, "no questions waiting", ctx.now, "dim"));
			const here = {
				...s,
				screen: "child" as const,
				runKey: q.run,
				childKey: q.child,
				filter: undefined,
				matrix: false,
			};
			return st({ ...go(s, here), answer: { ...q, text: "" } });
		}
		// The tab bar's numbers: the pages beside this one, as the bar lists them.
		case "1":
			if (side)
				return s.screen === "home"
					? none
					: st({ ...s, screen: "home", filter: undefined, stack: [] });
			if (s.screen === "run") return s.matrix ? st(flipMatrix(s)) : none;
			return s.screen === "worker" ? st(back(s)) : none;
		case "2":
			if (side)
				return s.screen === "activity"
					? none
					: st(go(s, { ...s, screen: "activity", filter: undefined }));
			if (s.screen === "run") return s.matrix ? none : st(flipMatrix(s));
			return s.screen === "child" ? openWorker(s, ctx) : none;
		case "3":
			return side && s.screen !== "machine"
				? st(go(s, { ...s, screen: "machine", filter: undefined }))
				: none;
		case "a":
			return side
				? st(go(s, { ...s, screen: "activity", filter: undefined }))
				: none;
		case "m":
			return side
				? st(go(s, { ...s, screen: "machine", filter: undefined }))
				: none;
		case "g":
			return s.screen === "run" ? st(flipMatrix(s)) : none;
		case "w":
			return s.screen === "child" ? openWorker(s, ctx) : none;
		case "n":
		case "N": {
			if (ch === "n" && side)
				return st({ ...s, command: { text: "new ", hist: -1 } });
			if (s.screen !== "worker" || !s.filter?.text) return none;
			const by = ch === "n" ? 1 : -1;
			return st({ ...s, tail: false, match: (s.match ?? -1) + by });
		}
		case "x":
			return s.screen === "home" ? archiveKey(s, ctx) : none;
		case "o":
			return s.screen === "machine"
				? none
				: withEffects(s, prOf(s, ctx), ctx.now);
		case "y": {
			if (s.screen === "child" || s.screen === "worker") {
				const wt = worktreeOf(s, ctx);
				return "path" in wt
					? {
							state: toast(s, `copied ${wt.path}`, ctx.now),
							effects: [{ kind: "copy", text: wt.path, what: "worktree" }],
						}
					: st(toast(s, wt.none, ctx.now, "dim"));
			}
			const { run, child } = selectedChild(s, ctx);
			const text = child?.key ?? run?.key;
			return text
				? {
						state: toast(s, `copied ${text}`, ctx.now),
						effects: [{ kind: "copy", text, what: text }],
					}
				: none;
		}
		case "e": {
			if (s.screen !== "child" && s.screen !== "worker") return none;
			const wt = worktreeOf(s, ctx);
			return "path" in wt
				? { state: s, effects: [{ kind: "editor", path: wt.path }] }
				: st(toast(s, wt.none, ctx.now, "dim"));
		}
		case "d": {
			if ((s.screen !== "run" && s.screen !== "child") || !s.runKey)
				return none;
			return runOf(ctx, s.runKey)?.hasEpicDiff
				? {
						state: s,
						effects: [{ kind: "pager", path: `${s.runKey}/epic.diff` }],
					}
				: st(
						toast(
							s,
							"no epic diff yet · it is written after the epic gate",
							ctx.now,
							"dim",
						),
					);
		}
		case "f": {
			if (s.screen !== "activity") return none;
			const total = ctx.home.runs.reduce((n, r) => n + r.events.length, 0);
			return st({
				...s,
				follow: !s.follow,
				pausedAt: s.follow ? total : undefined,
			});
		}
		case "s": {
			if (s.screen !== "home") return none;
			const sort =
				SORTS[(SORTS.indexOf(s.sort) + 1) % SORTS.length] ?? "activity";
			return st(toast({ ...s, sort }, `sort: ${sort}`, ctx.now, "dim"));
		}
		case "r":
			return { state: s, effects: [{ kind: "refresh" }] };
		default:
			return none;
	}
}

/**
 * The Worker page follows the end again once a scroll has landed on the last row: the
 * frame knows where the end is, the reducer does not.
 */
export function settleTail(s: ViewState, atEnd: boolean): ViewState {
	return s.screen === "worker" && !s.tail && atEnd && !s.filter?.text
		? { ...s, tail: true }
		: s;
}

/** Drops anything whose time has passed: a toast, a finished flash. */
export function expire(s: ViewState, now: number): ViewState {
	const toastGone = s.toast && s.toast.until <= now;
	const old = Object.entries(s.flashes).filter(([, at]) => now - at >= 600);
	if (!toastGone && !old.length) return s;
	const flashes = { ...s.flashes };
	for (const [k] of old) delete flashes[k];
	return { ...s, toast: toastGone ? undefined : s.toast, flashes };
}

export { childOf };
