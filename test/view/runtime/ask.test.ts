import { describe, expect, it } from "vitest";
import { parseViewArgs, stateFor } from "../../../src/view/args";
import { memoryFs } from "../../../src/view/model/fs";
import { readHome } from "../../../src/view/model/home";
import type { HomeView } from "../../../src/view/model/types";
import {
	panelHasKeys,
	questionsOf,
	refuseAsk,
	sentAsk,
	settleAsk as settleAt,
	shownQuestion,
} from "../../../src/view/runtime/ask";
import type { Key } from "../../../src/view/runtime/keys";
import {
	initialState,
	reduce,
	type ViewState,
} from "../../../src/view/runtime/state";
import { HOME } from "../helpers";

const at = (hms: string) => `2026-10-20T${hms}.000Z`;
const NOW = Date.parse(at("14:00:00"));
const OPTS = ["Allow it", "Copy it", "Do without"];

const parked = (child: string, t: string, data: Record<string, unknown>) =>
	JSON.stringify({
		at: at(t),
		child,
		attempt: 1,
		stage: "result",
		status: "parked",
		data,
	});
const homeOf = (runs: Record<string, string[]>): HomeView =>
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
		NOW,
	);
const ONE = homeOf({
	"ACME-700": [
		parked("ACME-701", "12:00:00", {
			message: "Which way?",
			options: OPTS,
			recommended: 1,
		}),
	],
});
const TWO = homeOf({
	"ACME-700": [parked("ACME-701", "13:30:00", { message: "later?" })],
	"ACME-800": [parked("ACME-801", "12:00:00", { message: "earlier?" })],
});
/** ACME-900 has nothing waiting: a child working. */
const quiet = [
	JSON.stringify({
		at: at("13:59:00"),
		child: "ACME-901",
		attempt: 1,
		stage: "dispatched",
		model: { requested: "opus" },
	}),
];
const NONE = homeOf({ "ACME-900": quiet });

const key = (s: string): Key =>
	s.length === 1 ? { name: "char", ch: s } : { name: s };
const ctxAt = (home: HomeView, now = NOW) => ({ home, now, rows: 36 });
/** Long enough ago that a question taken up then has been read. */
const READ = NOW - 60_000;
const settleAsk = (s: ViewState, home: HomeView, now = READ) =>
	settleAt(s, home, now);
function press(
	keys: string[],
	home: HomeView,
	s: ViewState = settleAsk(initialState(), home),
	now = NOW,
) {
	const effects = [];
	for (const k of keys) {
		const r = reduce(s, key(k), ctxAt(home, now));
		s = r.state;
		effects.push(...r.effects);
	}
	return { s, effects };
}
/** Keys with the milliseconds since the one before, from `from`. */
function timed(
	steps: [string, number][],
	home: HomeView,
	s: ViewState,
	from = NOW,
) {
	const effects = [];
	let now = from;
	for (const [k, wait] of steps) {
		now += wait;
		const r = reduce(s, key(k), ctxAt(home, now));
		s = r.state;
		effects.push(...r.effects);
	}
	return { s, effects, now };
}
const shown = (s: ViewState, home: HomeView) =>
	shownQuestion(settleAsk(s, home), home)?.child;

describe("which question", () => {
	it("goes oldest first across every run", () => {
		expect(questionsOf(TWO).map((q) => q.child)).toEqual([
			"ACME-801",
			"ACME-701",
		]);
	});
	it("leaves out a spec claim and a usage limit", () => {
		const claim = { path: "a", scenario: "s", assertion: "a", evidence: "e" };
		const h = homeOf({
			"ACME-700": [
				parked("ACME-701", "12:00:00", { message: "cannot", spec: claim }),
				parked("ACME-702", "13:00:00", { message: "which?" }),
				JSON.stringify({
					at: at("11:00:00"),
					child: "ACME-703",
					attempt: 1,
					stage: "result",
					status: "failed",
					data: { message: "usage" },
				}),
				JSON.stringify({
					at: at("11:00:05"),
					child: "ACME-703",
					attempt: 0,
					stage: "decision",
					status: "park",
					data: {
						kind: "failure",
						why: "every account is at its usage limit or not logged in; the soonest frees at 2026-10-20T15:30:00.000Z.",
					},
				}),
			],
		});
		expect(questionsOf(h).map((q) => q.child)).toEqual(["ACME-702"]);
		const onlyClaim = homeOf({
			"ACME-700": [
				parked("ACME-701", "12:00:00", { message: "cannot", spec: claim }),
			],
		});
		expect(questionsOf(onlyClaim)).toEqual([]);
		expect(settleAsk(initialState(), onlyClaim).ask).toBeUndefined();
	});
	it("puts the selected run's first, and showing a question selects its run", () => {
		const fresh = settleAsk(initialState(), TWO);
		// Nothing chosen yet: the list starts on its first row, which is ACME-700's.
		expect(fresh.ask?.child).toBe("ACME-701");
		const onOther = settleAsk(
			{ ...initialState(), selection: { "home:runs": "ACME-800" } },
			TWO,
		);
		expect(onOther.ask?.child).toBe("ACME-801");
		const three = homeOf({
			"ACME-700": [parked("ACME-701", "13:30:00", { message: "a?" })],
			"ACME-800": [parked("ACME-801", "12:00:00", { message: "b?" })],
			"ACME-900": quiet,
		});
		const fromQuiet = settleAsk(
			{ ...initialState(), selection: { "home:runs": "ACME-900" } },
			three,
		);
		expect(fromQuiet.ask?.child).toBe("ACME-801");
		expect(fromQuiet.selection["home:runs"]).toBe("ACME-800");
	});
	it("tab goes to the next, wrapping, and selects its run", () => {
		const { s } = press(["tab"], TWO);
		expect(s.ask?.child).toBe("ACME-801");
		expect(s.selection["home:runs"]).toBe("ACME-800");
		expect(press(["tab", "tab"], TWO).s.ask?.child).toBe("ACME-701");
	});
	it("moves with the list onto another waiting run, and stays put on a quiet one", () => {
		const three = homeOf({
			"ACME-700": [parked("ACME-701", "13:30:00", { message: "a?" })],
			"ACME-800": [parked("ACME-801", "12:00:00", { message: "b?" })],
			"ACME-900": quiet,
		});
		const list = press(["esc"], three).s;
		expect(list.ask?.child).toBe("ACME-701");
		const next = press(["down"], three, list).s;
		expect(next.selection["home:runs"]).toBe("ACME-800");
		expect(next.ask?.child).toBe("ACME-801");
		const onQuiet = press(["down"], three, next).s;
		expect(onQuiet.selection["home:runs"]).toBe("ACME-900");
		expect(onQuiet.ask?.child).toBe("ACME-801");
	});
});

describe("who has the keys", () => {
	const pressedAt = (home: HomeView, now: number) =>
		settleAsk({ ...initialState(), lastKeyAt: now }, home, now - 60_000);

	it("not on a Home nobody has pressed a key on, until the question has been up 2 seconds", () => {
		const s = settleAsk(initialState(), ONE, NOW);
		expect(panelHasKeys(s, ONE, NOW)).toBe(false);
		expect(panelHasKeys(s, ONE, NOW + 1999)).toBe(false);
		expect(panelHasKeys(s, ONE, NOW + 2000)).toBe(true);
	});
	it("not with no question, an overlay, a filter being edited or a command", () => {
		const s = settleAsk(initialState(), ONE);
		expect(panelHasKeys(s, ONE, NOW)).toBe(true);
		expect(panelHasKeys(settleAsk(initialState(), NONE), NONE, NOW)).toBe(
			false,
		);
		expect(panelHasKeys({ ...s, overlay: "help" }, ONE, NOW)).toBe(false);
		expect(
			panelHasKeys({ ...s, filter: { text: "", editing: true } }, ONE, NOW),
		).toBe(false);
		expect(
			panelHasKeys({ ...s, command: { text: "", hist: -1 } }, ONE, NOW),
		).toBe(false);
	});
	it("a question arriving while keys are pressed shows at once, with the keys after a 2 second pause", () => {
		const s = pressedAt(ONE, NOW - 100);
		expect(shown(s, ONE)).toBe("ACME-701");
		expect(panelHasKeys(s, ONE, NOW)).toBe(false);
		expect(panelHasKeys(s, ONE, NOW - 100 + 1999)).toBe(false);
		expect(panelHasKeys(s, ONE, NOW - 100 + 2000)).toBe(true);
	});
	it("a stray Enter just after a question arrives answers nothing", () => {
		const s = pressedAt(ONE, NOW - 100);
		for (const keys of [
			["enter"],
			["enter", "enter"],
			["enter", "enter", "enter"],
		]) {
			const r = press(keys, ONE, s);
			expect(r.effects).toEqual([]);
			// It leaves Home neither.
			expect(r.s.screen).toBe("home");
		}
	});
	it("arrows, tab and the rest in that pause stay the list's", () => {
		const s = pressedAt(TWO, NOW - 100);
		expect(press(["tab"], TWO, s).s.ask?.child).toBe(s.ask?.child);
		expect(press(["down"], TWO, s).s.ask?.choice).toBeUndefined();
		expect(press(["right"], TWO, s).s.screen).toBe("run");
	});
	it("the panel keeps them however fast they come, so typing never spills into the list", () => {
		let s = settleAsk(initialState(), ONE);
		for (const ch of "quit") s = reduce(s, key(ch), ctxAt(ONE, NOW + 10)).state;
		expect(s.ask?.text).toBe("quit");
		expect(s.screen).toBe("home");
	});
	it("records the last key's time from the reducer's clock", () => {
		expect(press(["down"], ONE, initialState(), NOW + 5).s.lastKeyAt).toBe(
			NOW + 5,
		);
	});
	it("esc in the pause dismisses too, so the panel does not take the keys after it", () => {
		const s = pressedAt(ONE, NOW - 100);
		const after = press(["esc"], ONE, s).s;
		expect(panelHasKeys(after, ONE, NOW + 60_000)).toBe(false);
		expect(shown(after, ONE)).toBe("ACME-701");
	});
	it("arriving with nothing waiting holds nothing for a question that comes after", () => {
		const away = press(["a"], NONE).s;
		const home = press(["esc"], NONE, away).s;
		expect(home.held).toBeFalsy();
		const s = settleAsk(home, ONE, NOW + 100);
		expect(panelHasKeys(s, ONE, NOW + 100)).toBe(false);
		expect(press(["enter"], ONE, s, NOW + 100).effects).toEqual([]);
	});
	it("^c and ^z stay the view's", () => {
		const s = pressedAt(ONE, NOW - 100);
		for (const state of [s, settleAsk(initialState(), ONE)]) {
			expect(press(["^c"], ONE, state).effects).toEqual([{ kind: "quit" }]);
			expect(press(["^z"], ONE, state).effects).toEqual([{ kind: "suspend" }]);
		}
	});
	it("a filter kept on the list does not stop the panel; one being edited does", () => {
		const s = settleAsk(initialState(), ONE);
		const kept: ViewState = {
			...s,
			filter: { text: "state:parked", editing: false },
		};
		expect(panelHasKeys(kept, ONE, NOW)).toBe(true);
		expect(press(["enter"], ONE, kept).effects).toMatchObject([
			{ kind: "answer", text: "Copy it" },
		]);
		const list = press(["esc"], ONE, kept).s;
		expect(panelHasKeys(list, ONE, NOW)).toBe(false);
		const back = press(["enter"], ONE, list).s;
		expect(back.dismissed).toBeUndefined();
		expect(back.screen).toBe("home");
		const editing: ViewState = {
			...s,
			filter: { text: "st", editing: true },
		};
		expect(press(["a"], ONE, editing).s.filter?.text).toBe("sta");
	});
	it("tab reaches a question a kept filter hides, and stays on it", () => {
		const hidden: ViewState = {
			...settleAsk(initialState(), TWO),
			filter: { text: "ACME-700", editing: false },
		};
		expect(hidden.ask?.child).toBe("ACME-701");
		const next = press(["tab"], TWO, hidden).s;
		expect(next.ask?.child).toBe("ACME-801");
		expect(settleAsk(next, TWO, NOW).ask?.child).toBe("ACME-801");
	});
});

describe("a key pressed without reading the question sends nothing", () => {
	const onRun = (): ViewState => ({
		...initialState(),
		screen: "run",
		runKey: "ACME-700",
	});
	const onActivity = (): ViewState => ({
		...initialState(),
		screen: "activity",
	});

	it("← ⏎ from a Run page, or launched on one, sends nothing", () => {
		for (const wait of [0, 10, 100, 1999]) {
			const r = timed(
				[
					["left", 0],
					["enter", wait],
				],
				ONE,
				onRun(),
			);
			expect(r.s.screen).toBe("home");
			expect(r.effects, `⏎ after ${wait} ms`).toEqual([]);
		}
	});
	it("then the pause alone gives ⏎ the panel", () => {
		const r = timed(
			[
				["left", 0],
				["enter", 2000],
			],
			ONE,
			onRun(),
		);
		expect(r.effects).toMatchObject([{ kind: "answer", text: "Copy it" }]);
	});
	it("h j j ⏎ from Activity sends nothing: the j's show as text, and stay", () => {
		const r = timed(
			[
				["h", 0],
				["j", 40],
				["j", 40],
				["enter", 40],
			],
			ONE,
			onActivity(),
		);
		expect(r.s.screen).toBe("home");
		expect(r.effects).toEqual([]);
		expect(r.s.ask?.text).toBe("jj");
	});
	it("→ ← ⏎ on a question in its pause sends nothing, nor → ← j j ⏎", () => {
		const s = settleAsk({ ...initialState(), lastKeyAt: NOW - 100 }, ONE);
		const out = timed(
			[
				["right", 0],
				["left", 50],
				["enter", 50],
			],
			ONE,
			s,
		);
		expect(out.s.screen).toBe("home");
		expect(out.effects).toEqual([]);
		const typed = timed(
			[
				["right", 0],
				["left", 50],
				["j", 50],
				["j", 50],
				["enter", 50],
			],
			ONE,
			s,
		);
		expect(typed.effects).toEqual([]);
		expect(typed.s.ask?.text).toBe("jj");
	});
	it("⏎ ⏎ on a waiting row after esc: the first comes back, the second is swallowed", () => {
		const list = press(["esc"], ONE).s;
		for (const wait of [0, 10, 500, 1999]) {
			const r = timed(
				[
					["enter", 3000],
					["enter", wait],
				],
				ONE,
				list,
			);
			expect(r.s.dismissed).toBeUndefined();
			expect(r.s.screen).toBe("home");
			expect(r.effects, `⏎ after ${wait} ms`).toEqual([]);
		}
	});
	it("that ⏎ starts the pause: after it, the keys come back and the next ⏎ sends", () => {
		const list = press(["esc"], ONE).s;
		const back = timed([["enter", 3000]], ONE, list);
		expect(panelHasKeys(back.s, ONE, back.now)).toBe(false);
		expect(panelHasKeys(back.s, ONE, back.now + 2000)).toBe(true);
		expect(
			reduce(back.s, key("enter"), ctxAt(ONE, back.now + 2000)).effects,
		).toMatchObject([{ kind: "answer", text: "Copy it" }]);
	});
	it("a held-down Enter sends nothing, however long it is held", () => {
		const repeats = (n: number, gap: number): [string, number][] =>
			Array.from({ length: n }, () => ["enter", gap]);
		// From a Run page.
		const arrived = timed([["left", 0], ...repeats(400, 30)], ONE, onRun());
		expect(arrived.effects).toEqual([]);
		// On a row after esc.
		const list = press(["esc"], ONE).s;
		expect(timed(repeats(400, 30), ONE, list, NOW + 5000).effects).toEqual([]);
		// As a question arrives while it is held.
		const s = settleAsk(initialState(), ONE, NOW);
		expect(timed(repeats(400, 30), ONE, s).effects).toEqual([]);
		// Over the typed text it would otherwise send.
		const jj = timed(
			[["h", 0], ["j", 40], ["j", 40], ...repeats(400, 30)],
			ONE,
			onActivity(),
		);
		expect(jj.effects).toEqual([]);
	});
	it("a held-down Enter that begins just before the pause ends still sends nothing", () => {
		const r = timed(
			[
				["left", 0],
				["enter", 1900],
				// A keyboard's delay before it repeats.
				["enter", 500],
				["enter", 30],
				["enter", 30],
			],
			ONE,
			onRun(),
		);
		expect(r.effects).toEqual([]);
	});
	it("letting go of it and pausing gives the keys back", () => {
		const r = timed(
			[
				["left", 0],
				...Array.from({ length: 100 }, (): [string, number] => ["enter", 30]),
			],
			ONE,
			onRun(),
		);
		expect(panelHasKeys(r.s, ONE, r.now + 1999)).toBe(false);
		expect(panelHasKeys(r.s, ONE, r.now + 2000)).toBe(true);
		expect(
			reduce(r.s, key("enter"), ctxAt(ONE, r.now + 2000)).effects,
		).toHaveLength(1);
	});
	it("five ⏎ a second apart do not put the pause off for ever", () => {
		const s = settleAsk({ ...initialState(), lastKeyAt: NOW }, ONE, NOW);
		const first = reduce(s, key("enter"), ctxAt(ONE, NOW + 1000));
		expect(first.effects).toEqual([]);
		const second = reduce(first.state, key("enter"), ctxAt(ONE, NOW + 2000));
		expect(second.effects).toMatchObject([{ kind: "answer" }]);
	});
	it("a swallowed ⏎ on its own does not restart the pause", () => {
		const s = settleAsk({ ...initialState(), lastKeyAt: NOW }, ONE, NOW);
		const after = reduce(s, key("enter"), ctxAt(ONE, NOW + 1500)).state;
		expect(after.lastKeyAt).toBe(NOW);
		expect(panelHasKeys(after, ONE, NOW + 2000)).toBe(true);
	});
	it("a question swapped while the person reads takes no keys for 2 seconds", () => {
		const reading = settleAsk(initialState(), ONE, NOW - 5000);
		const b = homeOf({
			"ACME-700": [
				parked("ACME-701", "13:00:00", { message: "B?", options: OPTS }),
			],
		});
		const swapped = settleAt(reading, b, NOW - 100);
		expect(swapped.ask?.since).toBe(at("13:00:00"));
		expect(panelHasKeys(swapped, b, NOW)).toBe(false);
		expect(press(["enter"], b, swapped).effects).toEqual([]);
		expect(panelHasKeys(swapped, b, NOW - 100 + 2000)).toBe(true);
		expect(
			press(["enter"], b, swapped, NOW - 100 + 2000).effects,
		).toMatchObject([{ kind: "answer", text: "Allow it" }]);
	});
	it("so is one swapped after the panel took a key: nothing held carries over", () => {
		const moved = press(["down"], ONE).s;
		const b = homeOf({
			"ACME-700": [
				parked("ACME-701", "13:00:00", { message: "B?", options: OPTS }),
			],
		});
		const swapped = settleAt(moved, b, NOW + 100);
		expect(swapped.held).toBeFalsy();
		expect(press(["enter"], b, swapped, NOW + 200).effects).toEqual([]);
	});
	it("a question arriving with no key ever pressed: the first ⏎ sends nothing", () => {
		const s = settleAt(initialState(), ONE, NOW);
		expect(s.lastKeyAt).toBeUndefined();
		expect(press(["enter"], ONE, s, NOW + 100).effects).toEqual([]);
		expect(press(["enter"], ONE, s, NOW + 2000).effects).toHaveLength(1);
	});
	it("moving the list onto another waiting run is a new question, and holds nothing", () => {
		const held: ViewState = { ...settleAsk(initialState(), TWO), held: true };
		const moved = settleAt(
			{ ...held, selection: { "home:runs": "ACME-800" } },
			TWO,
			NOW,
		);
		expect(moved.ask?.child).toBe("ACME-801");
		expect(moved.held).toBeUndefined();
		expect(panelHasKeys(moved, TWO, NOW + 100)).toBe(false);
	});
	it("tab shows a question to read: ⏎ waits, whatever ↑↓ chose, until it has been up", () => {
		const both = homeOf({
			"ACME-700": [
				parked("ACME-701", "12:00:00", { message: "a?", options: OPTS }),
				parked("ACME-702", "13:00:00", { message: "b?", options: OPTS }),
			],
		});
		const r = press(["tab", "enter"], both);
		expect(r.s.ask?.child).toBe("ACME-702");
		expect(r.effects).toEqual([]);
		const again = press(["tab", "tab"], both);
		expect(again.s.ask?.child).toBe("ACME-701");
		const chosen = press(["tab", "down", "enter"], both);
		expect(chosen.s.ask?.choice).toBe(1);
		expect(chosen.effects).toEqual([]);
		const tabbed = press(["tab"], both).s;
		const later = (steps: [string, number][]) =>
			timed(steps, both, tabbed, NOW).effects;
		expect(
			later([
				["down", 30],
				["enter", 30],
			]),
		).toEqual([]);
		expect(
			later([
				["down", 1000],
				["enter", 1100],
			]),
		).toMatchObject([{ child: "ACME-702", text: "Copy it" }]);
		expect(press(["tab"], both).s.lastKeyAt).toBe(NOW);
	});
	it("a dismissal ended by a new question does not hand over the old one at once", () => {
		const list = press(["down", "esc"], ONE).s;
		const more = homeOf({
			"ACME-700": [
				parked("ACME-701", "12:00:00", {
					message: "Which way?",
					options: OPTS,
					recommended: 1,
				}),
				parked("ACME-702", "13:00:00", { message: "new?" }),
			],
		});
		// Idle ten seconds, then the new one lands just before ⏎ meant for the list.
		const s = settleAt(list, more, NOW + 10_000);
		expect(s.dismissed).toBeUndefined();
		expect(press(["enter"], more, s, NOW + 10_100).effects).toEqual([]);
	});
	it("an empty paste holds nothing", () => {
		const s = settleAsk({ ...initialState(), lastKeyAt: NOW }, ONE);
		const r = reduce(s, { name: "paste", text: "\u0007" }, ctxAt(ONE, NOW + 1));
		expect(r.state.held).toBeFalsy();
		expect(press(["enter"], ONE, r.state, NOW + 2).effects).toEqual([]);
	});
});

describe("--select on Home", () => {
	const THREE = homeOf({
		"ACME-700": [parked("ACME-701", "13:30:00", { message: "a?" })],
		"ACME-800": [parked("ACME-801", "12:00:00", { message: "b?" })],
		"ACME-900": quiet,
	});
	const started = (select?: string) =>
		settleAsk(
			stateFor({ ...parseViewArgs([], false), select }, THREE, NOW),
			THREE,
			NOW,
		);
	it("shows that run's question first when it has one", () => {
		const s = started("ACME-700");
		expect(s.ask?.child).toBe("ACME-701");
		expect(s.selection["home:runs"]).toBe("ACME-700");
	});
	it("otherwise stays selected, with the oldest question showing", () => {
		const s = started("ACME-900");
		expect(s.ask?.child).toBe("ACME-801");
		expect(s.selection["home:runs"]).toBe("ACME-900");
		// A repaint does not take it back.
		expect(settleAsk(s, THREE, NOW + 1000).selection["home:runs"]).toBe(
			"ACME-900",
		);
	});
	it("does not outlast the person's first key, or the first question", () => {
		const s = started("ACME-900");
		expect(press(["esc"], THREE, s).s.selection["home:runs"]).toBe("ACME-900");
		const pressed = press(
			["esc", "down"],
			NONE,
			stateFor({ ...parseViewArgs([], false), select: "ACME-900" }, NONE, NOW),
		).s;
		const later = settleAsk(pressed, ONE, NOW);
		expect(later.selection["home:runs"]).toBe("ACME-700");
	});
	it("without it, showing a question still selects its run", () => {
		expect(started().selection["home:runs"]).toBe("ACME-700");
	});
});

describe("typing, whatever the pause says", () => {
	/** 500 ms after a send, with another question up. */
	const afterSend = () => {
		const sent = press(["a", "enter"], TWO);
		expect(sent.effects).toHaveLength(1);
		const left = homeOf({
			"ACME-800": [
				parked("ACME-801", "12:00:00", { message: "b?", options: OPTS }),
			],
		});
		return { left, s: settleAt(sentAsk(sent.s), left, NOW), now: NOW + 500 };
	};
	it("q, a, n and x just after a send are text: no quit, no page, no prompt, no archive", () => {
		const { left, s, now } = afterSend();
		const q = press(["q"], left, s, now);
		expect(q.effects).toEqual([]);
		expect(q.s.ask?.text).toBe("q");
		expect(press(["a"], left, s, now).s.screen).toBe("home");
		expect(press(["n"], left, s, now).s.command).toBeUndefined();
		const x = press(["x", "x"], left, s, now);
		expect(x.s.armed).toBeUndefined();
		expect(x.effects).toEqual([]);
		expect(x.s.ask?.text).toBe("xx");
	});
	it("/ o k ⏎ just after a send keeps no filter and sends nothing", () => {
		const { left, s, now } = afterSend();
		const r = press(["/", "o", "k", "enter"], left, s, now);
		expect(r.s.filter).toBeUndefined();
		expect(r.effects).toEqual([]);
		expect(r.s.ask?.text).toBe("/ok");
	});
	it("a paste in the pause is kept", () => {
		const s = settleAsk({ ...initialState(), lastKeyAt: NOW }, ONE, NOW);
		const r = reduce(s, { name: "paste", text: "a/b" }, ctxAt(ONE, NOW + 100));
		expect(r.state.ask?.text).toBe("a/b");
	});
	it("typing started at once keeps the keys, and ⏎ sends it once the question has been up 2 seconds", () => {
		const s = settleAsk({ ...initialState(), lastKeyAt: NOW }, ONE, NOW);
		const r = timed(
			[
				["o", 100],
				["k", 100],
			],
			ONE,
			s,
		);
		expect(panelHasKeys(r.s, ONE, r.now + 1)).toBe(true);
		expect(press(["enter"], ONE, r.s, NOW + 1999).effects).toEqual([]);
		expect(press(["enter"], ONE, r.s, NOW + 2000).effects).toMatchObject([
			{ kind: "answer", text: "ok" },
		]);
	});
	it("typed text stays through a swallowed ⏎, and the arrows are ignored over it", () => {
		const s = settleAsk(initialState(), ONE, NOW);
		const r = press(["o", "enter", "k", "down", "tab"], ONE, s, NOW + 100);
		expect(r.s.ask?.text).toBe("ok");
		expect(r.s.ask?.choice).toBeUndefined();
		expect(r.s.screen).toBe("home");
	});
	it("does not take keys from a dismissed panel, or an open overlay or command", () => {
		const list = press(["esc"], ONE).s;
		expect(press(["q"], ONE, list).effects).toEqual([{ kind: "quit" }]);
		const help = settleAsk({ ...initialState(), overlay: "help" }, ONE, NOW);
		expect(press(["z"], ONE, help).s.ask?.text).toBe("");
		const cmd = settleAsk(
			{ ...initialState(), command: { text: "", hist: -1 } },
			ONE,
			NOW,
		);
		expect(press(["z"], ONE, cmd).s.command?.text).toBe("z");
	});
	it("a panel the person went away from takes no ⏎ on the way back", () => {
		// → in the pause leaves with the question up; time passes on the Run page.
		const s = settleAsk({ ...initialState(), lastKeyAt: NOW }, ONE, NOW);
		const r = timed(
			[
				["right", 100],
				["left", 60_000],
				["enter", 100],
			],
			ONE,
			s,
		);
		expect(r.s.screen).toBe("home");
		expect(r.effects).toEqual([]);
	});
});

describe("esc, and coming back", () => {
	it("dismisses: the keys go to the list, the panel stays", () => {
		const { s } = press(["esc"], ONE);
		expect(panelHasKeys(s, ONE, NOW + 60_000)).toBe(false);
		expect(shown(s, ONE)).toBe("ACME-701");
		expect(press(["q"], ONE, s).effects).toEqual([{ kind: "quit" }]);
	});
	it("⏎ on a waiting run's row takes the keys back for its question", () => {
		const { s } = press(["esc"], TWO);
		const back = press(["enter"], TWO, s, NOW + 100);
		expect(back.effects).toEqual([]);
		expect(back.s.screen).toBe("home");
		expect(back.s.dismissed).toBeUndefined();
		expect(back.s.ask?.child).toBe("ACME-701");
		// It starts the pause; typing works at once and sends after it.
		expect(panelHasKeys(back.s, TWO, NOW + 100)).toBe(false);
		expect(panelHasKeys(back.s, TWO, NOW + 2100)).toBe(true);
		expect(
			press(["y", "enter"], TWO, back.s, NOW + 2100).effects,
		).toMatchObject([{ kind: "answer", child: "ACME-701", text: "y" }]);
	});
	it("→ on a waiting run's row still opens the Run page", () => {
		const { s } = press(["esc"], ONE);
		expect(press(["right"], ONE, s).s).toMatchObject({
			screen: "run",
			runKey: "ACME-700",
		});
	});
	it("⏎ on a quiet run's row still opens it", () => {
		const three = homeOf({
			"ACME-700": [parked("ACME-701", "13:30:00", { message: "a?" })],
			"ACME-900": quiet,
		});
		const list = press(["esc", "down"], three).s;
		expect(list.selection["home:runs"]).toBe("ACME-900");
		expect(press(["enter"], three, list).s).toMatchObject({
			screen: "run",
			runKey: "ACME-900",
		});
	});
	it("a change in the set of questions ends the dismissal", () => {
		const { s } = press(["esc"], ONE);
		const more = homeOf({
			"ACME-700": [
				parked("ACME-701", "12:00:00", { message: "Which way?" }),
				parked("ACME-702", "13:00:00", { message: "new?" }),
			],
		});
		// It came while keys were pressed, so it still waits for the pause.
		const after = settleAsk(s, more, NOW);
		expect(after.dismissed).toBeUndefined();
		expect(panelHasKeys(after, more, NOW)).toBe(false);
		expect(panelHasKeys(after, more, NOW + 2000)).toBe(true);
	});
});

describe("keys while the panel has them", () => {
	it("starts on the recommended choice, else the first", () => {
		expect(press(["enter"], ONE).effects).toMatchObject([
			{ kind: "answer", text: "Copy it" },
		]);
		const plain = homeOf({
			"ACME-700": [
				parked("ACME-701", "12:00:00", { message: "?", options: OPTS }),
			],
		});
		expect(press(["enter"], plain).effects).toMatchObject([
			{ text: "Allow it" },
		]);
	});
	it("↑↓ choose, stopping at the ends, and ⏎ sends that option's exact text", () => {
		expect(press(["down", "enter"], ONE).effects).toMatchObject([
			{
				kind: "answer",
				run: "ACME-700",
				child: "ACME-701",
				since: at("12:00:00"),
				text: "Do without",
			},
		]);
		expect(press(["down", "down", "down"], ONE).s.ask?.choice).toBe(2);
		expect(press(["up", "up", "up"], ONE).s.ask?.choice).toBe(0);
	});
	it("q starts a typed answer, and does not quit", () => {
		const { s, effects } = press(["q"], ONE);
		expect(effects).toEqual([]);
		expect(s.ask?.text).toBe("q");
	});
	it("every printable key is text: a, j, k, /, ?, :, n, x", () => {
		const keys = ["a", "j", "k", "/", "?", ":", "n", "x"];
		const { s, effects } = press(keys, ONE);
		expect(s.ask?.text).toBe("ajk/?:nx");
		expect(s.screen).toBe("home");
		expect(s.overlay ?? s.filter ?? s.command).toBeUndefined();
		expect(effects).toEqual([]);
	});
	it("a digit never picks a choice: it starts typing", () => {
		const { s, effects } = press(["2"], ONE);
		expect(effects).toEqual([]);
		expect(s.ask?.text).toBe("2");
		expect(s.ask?.choice).toBeUndefined();
		expect(press(["2", "enter"], ONE).effects).toMatchObject([{ text: "2" }]);
	});
	it("paste starts a typed answer, cleaned", () => {
		const { s } = press([], ONE);
		const r = reduce(
			s,
			{ name: "paste", text: "a\r\nb\rc\u001b[31m\u0007\td" },
			ctxAt(ONE),
		);
		expect(r.state.ask?.text).toBe("a\nb\nc[31m\td");
	});
	it("typing: ⏎ sends it trimmed, backspace edits, esc drops it and returns to the choices", () => {
		expect(press([" ", "o", "k", " ", "enter"], ONE).effects).toMatchObject([
			{ text: "ok" },
		]);
		expect(press(["o", "k", "backspace"], ONE).s.ask?.text).toBe("o");
		const dropped = press(["o", "k", "esc"], ONE).s;
		expect(dropped.ask?.text).toBe("");
		expect(panelHasKeys(dropped, ONE, NOW)).toBe(true);
		expect(press(["enter"], ONE, dropped).effects).toMatchObject([
			{ text: "Copy it" },
		]);
	});
	it("only blanks typed sends nothing", () => {
		expect(press([" ", "enter"], ONE).effects).toEqual([]);
	});
	it("with no options: only a typed reply, ⏎ alone sends nothing, and esc dismisses", () => {
		expect(press(["enter"], TWO).effects).toEqual([]);
		const typed = press(["o", "k"], TWO).s;
		const esc = press(["esc"], TWO, typed).s;
		expect(esc.ask?.text).toBe("");
		expect(panelHasKeys(esc, TWO, NOW + 60_000)).toBe(false);
	});
	it("tab while typing keeps the text where it is", () => {
		expect(press(["o", "tab"], TWO).s.ask).toMatchObject({
			child: "ACME-701",
			text: "o",
		});
	});
	it("leaves the arrows and paging keys off the list", () => {
		const { s } = press(["left", "right", "pgdn"], ONE);
		expect(s.screen).toBe("home");
		expect(s.selection["home:runs"]).toBe("ACME-700");
	});
});

describe("sending, and what a refresh brings", () => {
	it("after a send the next question shows, without the keys, so a double ⏎ cannot answer it", () => {
		const sent = press(["a", "enter"], TWO);
		expect(sent.effects).toHaveLength(1);
		const left = homeOf({
			"ACME-800": [parked("ACME-801", "12:00:00", { message: "b?" })],
		});
		const next = settleAt(sentAsk(sent.s), left, NOW);
		expect(next.ask?.child).toBe("ACME-801");
		expect(next.selection["home:runs"]).toBe("ACME-800");
		expect(panelHasKeys(next, left, NOW)).toBe(false);
		expect(press(["enter"], left, next).effects).toEqual([]);
		expect(panelHasKeys(next, left, NOW + 2000)).toBe(true);
	});
	it("a send lets go of the question and of the keys", () => {
		const sent = press(["a", "enter"], ONE).s;
		expect(sent.ask?.text).toBe("a");
		expect(sent.held).toBe(true);
		const after = sentAsk(sent);
		expect(after.ask).toBeUndefined();
		expect(after.held).toBeUndefined();
	});
	it("the panel closes when none are left", () => {
		const s = settleAt(sentAsk(press(["a", "enter"], ONE).s), NONE, NOW);
		expect(s.ask).toBeUndefined();
		expect(shownQuestion(s, NONE)).toBeUndefined();
		expect(panelHasKeys(s, NONE, NOW + 9000)).toBe(false);
	});
	it("a refused send keeps the panel and the text, with the reason, through any refresh", () => {
		const typed = press(["k", "e", "e", "p"], ONE).s;
		const refused = refuseAsk(typed, ONE, "ACME-701 is no longer waiting");
		const gone = settleAsk(refused, NONE);
		expect(gone.ask).toMatchObject({
			child: "ACME-701",
			text: "keep",
			refused: { message: "ACME-701 is no longer waiting" },
		});
		expect(shownQuestion(gone, NONE)?.text).toBe("Which way?");
		expect(panelHasKeys(gone, NONE, NOW)).toBe(true);
		// Still the panel's keys, still editing the same text.
		expect(press(["s"], NONE, gone).s.ask?.text).toBe("keeps");
		// esc does what the footer says, back to the choices, with the refusal still up.
		const choices = press(["esc"], NONE, gone).s;
		expect(choices.ask).toMatchObject({ child: "ACME-701", text: "" });
		expect(choices.ask?.refused).toBeDefined();
		expect(choices.dismissed).toBeUndefined();
		expect(panelHasKeys(choices, NONE, NOW)).toBe(true);
		expect(shownQuestion(choices, NONE)?.text).toBe("Which way?");
		// esc on the choices lets go of it, and the panel moves on.
		const out = press(["esc"], NONE, choices).s;
		expect(out.ask).toBeUndefined();
	});
	it("a refused send with no choices has nothing to go back to: esc lets go", () => {
		const typed = press(["k"], TWO).s;
		const refused = refuseAsk(typed, TWO, "no longer waiting");
		const out = press(["esc"], TWO, refused).s;
		expect(out.ask?.refused).toBeUndefined();
		expect(out.ask?.text).toBe("");
		expect(panelHasKeys(out, TWO, NOW + 60_000)).toBe(false);
	});
	it("a question that vanishes on a refresh moves on and drops what was chosen or typed", () => {
		const both = homeOf({
			"ACME-700": [
				parked("ACME-701", "12:00:00", { message: "a?", options: OPTS }),
				parked("ACME-702", "13:00:00", { message: "b?", options: OPTS }),
			],
		});
		const typed = press(["down", "t"], both).s;
		expect(typed.ask).toMatchObject({
			child: "ACME-701",
			choice: 1,
			text: "t",
		});
		const left = homeOf({
			"ACME-700": [
				parked("ACME-702", "13:00:00", { message: "b?", options: OPTS }),
			],
		});
		const moved = settleAt(typed, left, NOW);
		expect(moved.ask).toMatchObject({ child: "ACME-702", text: "" });
		expect(moved.ask?.choice).toBeUndefined();
		// The ⏎ meant for the old question cannot answer the new one.
		expect(panelHasKeys(moved, left, NOW)).toBe(false);
		expect(press(["enter"], left, moved).effects).toEqual([]);
	});
	it("a child parked again is a new question, even with the same key", () => {
		const typed = press(["t"], ONE).s;
		const again = homeOf({
			"ACME-700": [parked("ACME-701", "13:00:00", { message: "again?" })],
		});
		expect(settleAt(typed, again, NOW).ask).toMatchObject({
			since: at("13:00:00"),
			text: "",
		});
	});
	it("Q is only a letter now", () => {
		expect(press(["Q"], ONE).s.ask?.text).toBe("Q");
		const list = press(["esc"], ONE).s;
		const r = press(["Q"], ONE, list);
		expect(r.s.screen).toBe("home");
		expect(r.s.toast).toBeUndefined();
	});
});
