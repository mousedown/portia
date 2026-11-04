import { describe, expect, it } from "vitest";
import { memoryFs } from "../../../src/view/model/fs";
import { readHome } from "../../../src/view/model/home";
import { CHILD_HINTS } from "../../../src/view/render/screens/child";
import type { Key } from "../../../src/view/runtime/keys";
import {
	completions,
	initialState,
	reduce,
	resolveCommand,
	settleTail,
	type ViewState,
} from "../../../src/view/runtime/state";
import { currentList, selectedId } from "../../../src/view/select";
import { fixtureFs, HOME, NOW } from "../helpers";

const home = readHome(fixtureFs(), HOME, NOW);
const ctx = { home, now: NOW, rows: 36 };
const k = (s: string): Key =>
	s.length === 1 ? { name: "char", ch: s } : { name: s };
/**
 * Home with the cursor on ACME-500, the run in session. ACME-410, which waits on the
 * person's answer, sorts first, so a fresh Home starts on it instead.
 */
const atSession = (): ViewState => {
	const s = initialState();
	return { ...s, selection: { ...s.selection, "home:runs": "ACME-500" } };
};
/** Presses keys in order, from Home on ACME-500; returns the final state and every effect. */
function press(
	keys: string[],
	s: ViewState = atSession(),
	c: typeof ctx = ctx,
) {
	const effects = [];
	for (const key of keys) {
		const r = reduce(s, k(key), c);
		s = r.state;
		effects.push(...r.effects);
	}
	return { s, effects };
}
const sel = (s: ViewState) => {
	const { list, ids, def } = currentList(s, home, NOW);
	return selectedId(s, list, ids, def);
};

describe("moving", () => {
	it("moves over runs and skips labels; the selection is a key", () => {
		// The run waiting on the person's answer comes first, so Home starts on it.
		expect(sel(initialState())).toBe("ACME-410");
		expect(sel(press(["down"], initialState()).s)).toBe("ACME-500");
		expect(sel(press(["j", "j", "k"], initialState()).s)).toBe("ACME-500");
		expect(sel(press(["end"]).s)).toBe("ACME-377");
		expect(sel(press(["end", "home"]).s)).toBe("ACME-410");
		expect(press(["end"]).s.selection["home:runs"]).toBe("ACME-377");
	});
	it("opens a run, then a child, then its worker, and comes back the way it went", () => {
		const { s } = press(["right"]);
		expect(s).toMatchObject({ screen: "run", runKey: "ACME-500" });
		// A run opens on the child that needs attention: the one running, not the first.
		expect(sel(s)).toBe("ACME-505");
		const deeper = press(["j", "enter"], s).s;
		expect(deeper).toMatchObject({ screen: "child", childKey: "ACME-506" });
		const worker = press(["w"], deeper).s;
		expect(worker).toMatchObject({ screen: "worker", childKey: "ACME-506" });
		const back = press(["left"], worker).s;
		expect(back.screen).toBe("child");
		const run = press(["esc"], back).s;
		expect(run.screen).toBe("run");
		expect(sel(run)).toBe("ACME-506");
		expect(press(["h"], run).s.screen).toBe("home");
	});
	it("reaches a child's evidence in two keypresses from Home", () => {
		const { s } = press(["enter", "enter"]);
		expect(s).toMatchObject({ screen: "child", childKey: "ACME-505" });
		// The first thing the cursor is on is the first requirement.
		expect(sel(s)).toBe("ev:ACME-505:R5");
	});
	it("puts Activity and Machine beside Home, on a and m", () => {
		expect(press(["a"]).s.screen).toBe("activity");
		expect(press(["m"]).s.screen).toBe("machine");
		expect(press(["a", "m"]).s.screen).toBe("machine");
		expect(press(["m", "esc"]).s.screen).toBe("home");
		expect(press(["a", "left"]).s.screen).toBe("home");
		// Not from inside a run: there a and m mean nothing.
		expect(press(["enter", "a"]).s.screen).toBe("run");
		expect(press(["enter", "m"]).s.screen).toBe("run");
	});
	it("flips the Run page to its gate matrix on g, keeping the selected child", () => {
		const run = press(["enter", "j"]).s;
		expect(sel(run)).toBe("ACME-506");
		const m = press(["g"], run).s;
		expect(m.matrix).toBe(true);
		expect(sel(m)).toBe("ACME-506");
		expect(press(["enter"], m).s).toMatchObject({
			screen: "child",
			childKey: "ACME-506",
		});
		expect(press(["g"], m).s.matrix).toBe(false);
		// Opening another run starts on its children list.
		expect(press(["esc", "j", "enter"], m).s.matrix).toBe(false);
	});
	it("scrolls the Machine page with the cursor keys, which has no list", () => {
		const m = press(["m"]).s;
		expect(currentList(m, home, NOW).ids).toEqual([]);
		const s = press(["j", "j", "down", "k"], m).s;
		expect(s.scroll.machine).toBe(2);
		expect(press(["home"], s).s.scroll.machine).toBe(0);
		expect(press(["k", "k"], m).s.scroll.machine).toBe(0);
		// Nothing there to filter.
		expect(press(["/"], m).s.filter).toBeUndefined();
	});
});

/** Every page, reached the way a person would. */
const PAGES: [string, string[]][] = [
	["home", []],
	["activity", ["a"]],
	["machine", ["m"]],
	["run", ["enter"]],
	["gates", ["enter", "g"]],
	["child", ["enter", "j", "enter"]],
	["worker", ["enter", "j", "enter", "w"]],
];

describe("the key map", () => {
	it("switches the tab bar's pages on 1–3, and nothing else steps through them", () => {
		const where = (r: { s: { screen: string; matrix?: boolean } }) =>
			r.s.screen === "run" && r.s.matrix ? "gates" : r.s.screen;
		const tabs: Record<string, Record<string, string>> = {
			home: { "1": "home", "2": "activity", "3": "machine" },
			activity: { "1": "home", "2": "activity", "3": "machine" },
			machine: { "1": "home", "2": "activity", "3": "machine" },
			run: { "1": "run", "2": "gates", "3": "run" },
			gates: { "1": "run", "2": "gates", "3": "gates" },
			child: { "1": "child", "2": "worker", "3": "child" },
			worker: { "1": "child", "2": "worker", "3": "worker" },
		};
		for (const [name, path] of PAGES) {
			const at = press(path).s;
			for (const [key, to] of Object.entries(tabs[name] ?? {}))
				expect(where(press([key], at)), `${name} ${key}`).toBe(to);
			for (const key of ["tab", "stab", "[", "]", "4", "5"]) {
				const r = press([key], at);
				expect(r.s, `${name} ${key}`).toEqual(at);
				expect(r.effects, `${name} ${key}`).toEqual([]);
			}
		}
	});
	it("archives a finished run on x twice, and nothing that is still going", () => {
		const on = (run: string): ViewState => ({
			...initialState(),
			selection: { "home:runs": run },
		});
		// Once only asks; the second press within three seconds archives.
		const once = press(["x"], on("ACME-390"));
		expect(once.effects).toEqual([]);
		expect(once.s.toast?.text).toMatch(/x again to archive ACME-390/);
		expect(press(["x", "x"], on("ACME-390")).effects).toEqual([
			{ kind: "archive", run: "ACME-390" },
		]);
		expect(press(["x", "x"], on("ACME-377")).effects).toEqual([
			{ kind: "archive", run: "ACME-377" },
		]);
		// Too late: the second press starts over.
		const late = reduce(once.s, k("x"), { ...ctx, now: NOW + 3_001 });
		expect(late.effects).toEqual([]);
		// A run in session, waiting on a person or awaiting judgement is never archived.
		for (const run of ["ACME-500", "ACME-410", "ACME-366"]) {
			const r = press(["x", "x"], on(run));
			expect(r.effects, run).toEqual([]);
			expect(r.s.toast?.text, run).toMatch(/only a run at rest or delivered/);
		}
		// Only on Home.
		expect(press(["enter", "x", "x"]).effects).toEqual([]);
	});
	it("goes back up one page on ← and esc, from every page", () => {
		const up: Record<string, string> = {
			home: "home",
			activity: "home",
			machine: "home",
			run: "home",
			gates: "home",
			child: "run",
			worker: "child",
		};
		for (const [name, path] of PAGES)
			for (const key of ["left", "esc", "backspace", "h"])
				expect(press([...path, key]).s.screen, `${name} ${key}`).toBe(up[name]);
	});
	it("goes down on → and ⏎ wherever there is somewhere to go", () => {
		const down: Record<string, string> = {
			home: "run",
			activity: "child",
			machine: "machine",
			run: "child",
			gates: "child",
			worker: "worker",
		};
		for (const [name, path] of PAGES) {
			if (name === "child") continue;
			for (const key of ["right", "enter", "l"]) {
				// On Activity ⏎ unfolds the row in place; → and l open its child.
				const want =
					name === "activity" && key === "enter" ? "activity" : down[name];
				expect(press([...path, key]).s.screen, `${name} ${key}`).toBe(want);
			}
		}
	});
	it("comes back to Activity, on the same row, from the child it opened", () => {
		const feed = press(["a", "down", "down", "down", "down", "down"]).s;
		const row = sel(feed);
		const child = press(["right"], feed).s;
		expect(child).toMatchObject({ screen: "child", childKey: "ACME-505" });
		const back = press(["esc"], child).s;
		expect(back.screen).toBe("activity");
		expect(sel(back)).toBe(row);
		expect(back.scroll).toEqual(feed.scroll);
		// Back retraces every step it went down, then Home.
		expect(press(["esc"], back).s.screen).toBe("home");
	});
	it("unfolds an Activity row on ⏎ and folds it again", () => {
		const feed = press(["a", "down", "down", "down", "down", "down"]).s;
		const id = sel(feed) ?? "";
		const open = press(["enter"], feed).s;
		expect(open.screen).toBe("activity");
		expect(open.expanded).toContain(id);
		expect(press(["enter"], open).s.expanded).not.toContain(id);
	});
	it("on a child, ⏎ expands evidence, gates and attempts and → on the worker row opens it", () => {
		const child = press(["enter", "enter"]).s;
		const ev = press(["enter"], child).s;
		expect(ev.expanded).toContain("ev:ACME-505:R5");
		expect(press(["enter"], ev).s.expanded).not.toContain("ev:ACME-505:R5");
		// ↓ once lands on the failed exit gate, whose reason ⏎ opens.
		const gate = press(["j"], child).s;
		expect(sel(gate)).toBe("gate:ACME-505:exit:1");
		expect(press(["enter"], gate).s.expanded).toContain("gate:ACME-505:exit:1");
		// The worker row comes next; ACME-505's worker is a subagent, so it says so.
		const w = press(["j", "j", "right"], child).s;
		expect(w.screen).toBe("child");
		expect(w.toast?.text).toContain("orchestrator's session");
		// The current attempt starts open; ⏎ closes it and its rows leave the list.
		const att = press(["j", "j", "j"], child).s;
		expect(sel(att)).toBe("att:ACME-505:2");
		const before = currentList(att, home, NOW).ids.length;
		const closed = press(["enter"], att).s;
		expect(currentList(closed, home, NOW).ids.length).toBeLessThan(before);
		const detached = press(["enter", "j", "enter", "j", "enter"]).s;
		expect(detached.screen).toBe("worker");
		// A key clears a toast: it never stays across pages.
		expect(press(["left"], w).s.toast).toBeUndefined();
	});
	it("scrolls the Worker page, stops following, and end follows again", () => {
		const w = press(["enter", "j", "enter", "w"]).s;
		expect(w.tail).toBe(true);
		// Following, a move down is already at the end and keeps following.
		expect(press(["down"], w).s.tail).toBe(true);
		expect(press(["pgdn"], w).s.tail).toBe(true);
		const up = press(["up"], w).s;
		expect(up.tail).toBe(false);
		expect(press(["end"], up).s.tail).toBe(true);
		// A scroll back down onto the last row follows again.
		expect(settleTail(press(["down"], up).s, true).tail).toBe(true);
		expect(settleTail(press(["up"], up).s, false).tail).toBe(false);
		const found = press([..."/opus".split(""), "enter", "n", "n"], w).s;
		expect(found.filter).toEqual({ text: "opus", editing: false });
		expect(found.match).toBe(1);
		expect(press(["N"], found).s.match).toBe(0);
		// While searching, ↑ and ↓ go from match to match as N and n do.
		expect(press(["up"], found).s.match).toBe(0);
		expect(press(["down"], found).s.match).toBe(2);
	});
	it("copies the worktree and opens the editor from a child, never writing", () => {
		const child = press(["enter", "enter"]).s;
		const wt = "/home/acme/.portia/worktrees/acme-app/ACME-505";
		expect(press(["y"], child).effects).toEqual([
			{ kind: "copy", text: wt, what: "worktree" },
		]);
		expect(press(["e"], child).effects).toEqual([{ kind: "editor", path: wt }]);
		expect(press(["e"]).effects).toEqual([]);
		// ACME-503's env was torn down and its worktree is gone: nothing to open.
		const gone = press([..."::child 503".split("").slice(1), "enter"]).s;
		expect(gone.childKey).toBe("ACME-503");
		const e = press(["e"], gone);
		expect(e.effects).toEqual([]);
		expect(e.s.toast?.text).toBe("the worktree was removed at 09:17");
		expect(press(["y"], gone).effects).toEqual([]);
	});
});

describe("the filter and the command line", () => {
	it("narrows the list as you type, keeps it on ⏎ and clears it on esc", () => {
		let { s } = press([
			"/",
			"s",
			"t",
			"a",
			"t",
			"e",
			":",
			"p",
			"a",
			"r",
			"k",
			"e",
			"d",
		]);
		expect(currentList(s, home, NOW).ids).toEqual(["ACME-410"]);
		s = press(["enter"], s).s;
		expect(s.filter).toEqual({ text: "state:parked", editing: false });
		expect(press(["esc"], s).s.filter).toBeUndefined();
		const typed = press(["/", "x", "esc"]).s;
		expect(typed.filter).toBeUndefined();
	});
	it("ORs words of one kind: state:parked state:failed", () => {
		const { s } = press([..."/state:parked state:failed".split("")]);
		expect(currentList(s, home, NOW).ids).toEqual(["ACME-410", "ACME-366"]);
	});
	it("runs any unique prefix, completes on tab, and keeps a history", () => {
		expect(resolveCommand("ch")).toBe("child");
		expect(resolveCommand("r")).toEqual(["run", "refresh"]);
		let { s } = press([..."::ch 505".split("").slice(1), "enter"]);
		expect(s).toMatchObject({
			screen: "child",
			runKey: "ACME-500",
			childKey: "ACME-505",
		});
		s = press([":", "up"], s).s;
		expect(s.command?.text).toBe("ch 505");
		expect(press([":", "r", "u", "tab"]).s.command?.text).toBe("run ");
		expect(completions("run ACME-4", home)).toEqual(["ACME-410"]);
	});
	it("says so for an unknown command, in failed, for 3 s", () => {
		const { s } = press([":", "l", "n", "a", "d", "enter"]);
		expect(s.toast).toEqual({
			text: "unknown command: lnad   (try :help)",
			role: "failed",
			until: NOW + 3000,
		});
	});
	it("has no write commands, ever", () => {
		for (const word of ["land", "dispatch", "decide", "park"])
			expect(Array.isArray(resolveCommand(word))).toBe(true);
	});
});

describe("effects", () => {
	it("suspends on ^z, which raw mode delivers as a key, not a signal", () => {
		expect(press(["^z"]).effects).toEqual([{ kind: "suspend" }]);
		expect(press([":", "^z"]).effects).toEqual([{ kind: "suspend" }]);
	});
	it("quits on q, ^c and :q", () => {
		expect(press(["q"]).effects).toEqual([{ kind: "quit" }]);
		expect(press(["/", "^c"]).effects).toEqual([{ kind: "quit" }]);
		expect(press([":", "q", "enter"]).effects).toEqual([{ kind: "quit" }]);
	});
	it("starts a new run on n, or resumes one that waits", () => {
		expect(press(["n"]).s.command?.text).toBe("new ");
		expect(press(["a", "n"]).s.command?.text).toBe("new ");
		const run = (key: string) => press(["n", ...[...key], "enter"]);
		expect(run("acme-600").effects).toEqual([
			{ kind: "launch", key: "ACME-600", prompt: "/portia ACME-600" },
		]);
		expect(run("ACME-410").effects).toEqual([
			{
				kind: "launch",
				key: "ACME-410",
				prompt: "/portia resume ACME-410",
				run: "ACME-410",
			},
		]);
		for (const [key, why] of [
			["ACME-500", "ACME-500 is already in session"],
			["ACME-377", "ACME-377 is already delivered"],
			["oops", "usage: :new KEY   (an epic or story, e.g. PROJ-123)"],
		]) {
			const { s, effects } = run(key ?? "");
			expect(effects).toEqual([]);
			expect(s.toast?.text).toBe(why);
		}
		expect(completions("new ", home)).toEqual([
			"ACME-410",
			"ACME-366",
			"ACME-390",
			"ACME-352",
		]);
	});
	it("opens the PR of what is selected", () => {
		expect(press(["o"]).effects).toEqual([
			{ kind: "open", run: "ACME-500", pr: 412 },
		]);
		expect(press(["enter", "home", "o"]).effects).toEqual([
			{ kind: "open", run: "ACME-500", pr: 415 },
		]);
		// A child with no PR yet says so, and how to reach the epic PR.
		const none = press(["enter", "o"]);
		expect(none.effects).toEqual([]);
		expect(none.s.toast?.text).toBe(
			"ACME-505 has no PR yet · :open ACME-500 opens the epic PR #412",
		);
	});
	it("copies keys, pages the diff, re-reads", () => {
		expect(press(["y"]).effects).toEqual([
			{ kind: "copy", text: "ACME-500", what: "ACME-500" },
		]);
		expect(press(["enter", "y"]).effects).toEqual([
			{ kind: "copy", text: "ACME-505", what: "ACME-505" },
		]);
		const child = press(["enter", "enter"]).s;
		// No epic diff yet: d says when there will be one.
		const none = press(["d"], child);
		expect(none.effects).toEqual([]);
		expect(none.s.toast?.text).toBe(
			"no epic diff yet · it is written after the epic gate",
		);
		const withDiff = {
			...ctx,
			home: readHome(
				fixtureFs({ [`${HOME}/runs/ACME-500/epic.diff`]: "diff\n" }),
				HOME,
				NOW,
			),
		};
		expect(press(["d"], child, withDiff).effects).toEqual([
			{ kind: "pager", path: "ACME-500/epic.diff" },
		]);
		expect(press(["r"]).effects).toEqual([{ kind: "refresh" }]);
	});
	it("expands a fold, then hands the full text to the pager", () => {
		const child = press(["enter", "enter"]).s;
		const run = home.runs.find((r) => r.key === "ACME-500");
		const land = run?.events.find(
			(e) => e.child === "ACME-505" && e.row.stage === "land",
		);
		// The land failure is in attempt 1, which starts closed: open it first.
		const open = { ...child, expanded: ["att:ACME-505:1"] };
		const s = {
			...open,
			selection: {
				...open.selection,
				"child:ACME-500:ACME-505": land?.id ?? "",
			},
		};
		const once = press(["enter"], s).s;
		expect(once.expanded).toContain(land?.id);
		expect(press(["enter"], once).effects[0]).toMatchObject({ kind: "pager" });
	});
	it("follows on Activity and pauses with a count", () => {
		const { s } = press(["a", "f"]);
		expect(s.follow).toBe(false);
		expect(s.pausedAt).toBeGreaterThan(0);
		expect(press(["f"], s).s.follow).toBe(true);
	});
	it("cycles the sort", () => {
		expect(press(["s"]).s.sort).toBe("key");
		expect(press(["s", "s", "s"]).s.sort).toBe("activity");
	});
	it("opens and closes help", () => {
		const { s } = press(["?"]);
		expect(s.overlay).toBe("help");
		expect(press(["esc"], s).s.overlay).toBeUndefined();
		expect(press(["?"], s).s.overlay).toBeUndefined();
	});
});

describe("answering a parked question", () => {
	const char = (ch: string): Key => ({ name: "char", ch });
	const parkedKids = (h: typeof home) =>
		h.runs.flatMap((r) =>
			r.children
				.filter((c) => c.wait?.kind === "question")
				.map((c) => ({ run: r.key, c })),
		);
	it("Q opens the oldest waiting question with an answer box", () => {
		const r = reduce(initialState(), char("Q"), ctx);
		const oldest = parkedKids(ctx.home).sort((a, b) =>
			(a.c.wait?.at ?? "").localeCompare(b.c.wait?.at ?? ""),
		)[0];
		expect(oldest).toBeDefined();
		expect(r.state.screen).toBe("child");
		expect(r.state.runKey).toBe(oldest?.run);
		expect(r.state.childKey).toBe(oldest?.c.key);
		expect(r.state.answer).toMatchObject({ child: oldest?.c.key, text: "" });
	});
	it("Q says so when nothing waits", () => {
		const quiet = { ...ctx, home: { ...ctx.home, runs: [] } };
		const r = reduce(initialState(), char("Q"), quiet);
		expect(r.state.answer).toBeUndefined();
		expect(r.state.toast?.text).toBe("no questions waiting");
	});
	it("the box takes every key as text, sends on enter and cancels on esc", () => {
		let s = reduce(initialState(), char("Q"), ctx).state;
		s = reduce(s, char("q"), ctx).state;
		s = reduce(s, char("x"), ctx).state;
		expect(s.answer?.text).toBe("qx");
		const sent = reduce(s, { name: "enter" }, ctx);
		expect(sent.effects[0]).toMatchObject({ kind: "answer", text: "qx" });
		expect(reduce(s, { name: "esc" }, ctx).state.answer).toBeUndefined();
	});
	it("backspace and paste edit the text", () => {
		let s = reduce(initialState(), char("Q"), ctx).state;
		s = reduce(s, { name: "paste", text: "abc" }, ctx).state;
		s = reduce(s, { name: "backspace" }, ctx).state;
		expect(s.answer?.text).toBe("ab");
	});
	it("enter on an empty box sends nothing", () => {
		const s = reduce(initialState(), char("Q"), ctx).state;
		expect(reduce(s, { name: "enter" }, ctx).effects).toEqual([]);
	});
});

describe("Q across runs, and spec claims", () => {
	const at = (hms: string) => `2026-10-20T${hms}.000Z`;
	const line = (child: string, t: string, data: Record<string, unknown>) =>
		JSON.stringify({
			at: at(t),
			child,
			attempt: 1,
			stage: "result",
			status: "parked",
			data,
		});
	const homeOf = (runs: Record<string, string[]>) =>
		readHome(
			memoryFs(
				Object.fromEntries(
					Object.entries(runs).map(([k, v]) => [
						`${HOME}/runs/${k}/runlog.jsonl`,
						`${v.join("\n")}\n`,
					]),
				),
			),
			HOME,
			Date.parse(at("14:00:00")),
		);
	const ctxOf = (h: typeof home) => ({ home: h, now: Date.parse(at("14:00:00")), rows: 36 });
	const Q: Key = { name: "char", ch: "Q" };

	it("Q picks the oldest question across two runs, not the first run's", () => {
		const h = homeOf({
			"ACME-700": [line("ACME-701", "13:30:00", { message: "later?" })],
			"ACME-800": [line("ACME-801", "12:00:00", { message: "earlier?" })],
		});
		const r = reduce(initialState(), Q, ctxOf(h));
		expect(r.state.runKey).toBe("ACME-800");
		expect(r.state.answer).toMatchObject({ run: "ACME-800", child: "ACME-801" });
	});

	it("Q skips a spec claim, which is settled by amendment, not by an answer", () => {
		const claim = { path: "a.feature", scenario: "s", assertion: "a", evidence: "e" };
		const h = homeOf({
			"ACME-700": [
				line("ACME-701", "12:00:00", { message: "cannot pass", spec: claim }),
				line("ACME-702", "13:30:00", { message: "which?" }),
			],
		});
		const r = reduce(initialState(), Q, ctxOf(h));
		expect(r.state.answer).toMatchObject({ child: "ACME-702" });
		const only = homeOf({
			"ACME-700": [line("ACME-701", "12:00:00", { message: "x", spec: claim })],
		});
		const none = reduce(initialState(), Q, ctxOf(only));
		expect(none.state.answer).toBeUndefined();
		expect(none.state.toast?.text).toBe("no questions waiting");
		const c = only.runs[0]?.children[0];
		expect(c && CHILD_HINTS(c)).not.toContain("Q answer");
	});

	it("paste drops control characters and normalises line endings", () => {
		const h = homeOf({
			"ACME-700": [line("ACME-701", "12:00:00", { message: "which?" })],
		});
		let st = reduce(initialState(), Q, ctxOf(h)).state;
		st = reduce(st, { name: "paste", text: "a\r\nb\rc\u001b[31m\u0007\td" }, ctxOf(h)).state;
		expect(st.answer?.text).toBe("a\nb\nc[31m\td");
	});
});
