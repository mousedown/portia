import { describe, expect, it } from "vitest";
import { memoryFs } from "../../../src/view/model/fs";
import { readHome } from "../../../src/view/model/home";
import type { HomeView } from "../../../src/view/model/types";
import {
	panelHasKeys,
	questionsOf,
	refuseAsk,
	settleAsk,
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
function press(
	keys: string[],
	home: HomeView,
	s: ViewState = initialState(),
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
		settleAsk({ ...initialState(), lastKeyAt: now }, home);

	it("the panel, on a Home nobody has pressed a key on", () => {
		expect(panelHasKeys(settleAsk(initialState(), ONE), ONE, NOW)).toBe(true);
	});
	it("not with no question, an overlay, a filter or a command", () => {
		const s = settleAsk(initialState(), ONE);
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
		// Each press starts the pause again.
		const after = press(["enter"], ONE, s).s;
		expect(panelHasKeys(after, ONE, NOW + 1999)).toBe(false);
		expect(panelHasKeys(after, ONE, NOW + 2000)).toBe(true);
	});
	it("other keys in that pause stay the list's", () => {
		const s = pressedAt(ONE, NOW - 100);
		expect(press(["q"], ONE, s).effects).toEqual([{ kind: "quit" }]);
		expect(press(["a"], ONE, s).s.screen).toBe("activity");
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
	it("coming back to Home is arriving: the keys at once", () => {
		const list = press(["esc"], ONE).s;
		// esc dismissed it, so going away and back leaves it dismissed.
		const back = press(["a", "esc"], ONE, list).s;
		expect(panelHasKeys(back, ONE, NOW)).toBe(false);
		const fresh = press(["a"], TWO, pressedAt(NONE, NOW)).s;
		expect(fresh.screen).toBe("activity");
		const home = press(["esc"], TWO, fresh).s;
		expect(home.screen).toBe("home");
		expect(panelHasKeys(home, TWO, NOW)).toBe(true);
		expect(press(["z"], TWO, home).s.ask?.text).toBe("z");
	});
	it("coming back to a dismissed question holds nothing for the next set of questions", () => {
		const away = press(["esc", "a"], ONE).s;
		const home = press(["esc"], ONE, away).s;
		expect(home.screen).toBe("home");
		expect(home.held).toBeFalsy();
		// A new question then arrives: the pause still guards it.
		const r = press(["enter"], TWO, home, NOW + 100);
		expect(r.effects).toEqual([]);
		expect(panelHasKeys(r.s, TWO, NOW + 100)).toBe(false);
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
		const s = settleAsk(home, ONE);
		expect(panelHasKeys(s, ONE, NOW + 100)).toBe(false);
		expect(press(["enter"], ONE, s, NOW + 100).effects).toEqual([]);
	});
	it("^c and ^z stay the view's", () => {
		expect(press(["^c"], ONE).effects).toEqual([{ kind: "quit" }]);
		expect(press(["^z"], ONE).effects).toEqual([{ kind: "suspend" }]);
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
		expect(panelHasKeys(back.s, TWO, NOW + 100)).toBe(true);
		expect(back.s.ask?.child).toBe("ACME-701");
		// Only the next ⏎ sends, and it is a typed reply here, so nothing yet.
		expect(press(["y", "enter"], TWO, back.s).effects).toMatchObject([
			{ kind: "answer", child: "ACME-701", text: "y" },
		]);
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
		expect(panelHasKeys(s, more, NOW)).toBe(false);
		expect(panelHasKeys(s, more, NOW + 2000)).toBe(true);
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
	const cleared = (s: ViewState): ViewState => ({
		...s,
		ask: undefined,
		held: undefined,
	});
	it("after a send the next question shows, without the keys, so a double ⏎ cannot answer it", () => {
		const sent = press(["a", "enter"], TWO);
		expect(sent.effects).toHaveLength(1);
		const left = homeOf({
			"ACME-800": [parked("ACME-801", "12:00:00", { message: "b?" })],
		});
		const next = settleAsk(cleared(sent.s), left);
		expect(next.ask?.child).toBe("ACME-801");
		expect(next.selection["home:runs"]).toBe("ACME-800");
		expect(panelHasKeys(next, left, NOW)).toBe(false);
		expect(press(["enter"], left, next).effects).toEqual([]);
		expect(panelHasKeys(next, left, NOW + 2000)).toBe(true);
	});
	it("the panel closes when none are left", () => {
		const s = settleAsk(cleared(press(["a", "enter"], ONE).s), NONE);
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
		// esc lets go of it, and the panel moves on.
		const out = press(["esc"], NONE, gone).s;
		expect(out.ask).toBeUndefined();
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
		const moved = settleAsk(typed, left);
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
		expect(settleAsk(typed, again).ask).toMatchObject({
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
