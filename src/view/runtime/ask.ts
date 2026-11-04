import type { HomeView } from "../model/types";
import { homeRuns, selectedId } from "../select";
import type { Key } from "./keys";
import type { Effect, Reduced, ViewState } from "./state";

/** A worker's question waiting on the person, as Home's panel shows it. */
export interface Question {
	run: string;
	child: string;
	since: string;
	text: string;
	summary: string;
	options?: string[];
	recommended?: number;
}

/** What the panel is on: the question, the choice moved to and the answer typed so far. */
export interface Ask {
	run: string;
	child: string;
	since: string;
	/** The run the order puts first, fixed when it was taken up, so tab walks one order. */
	first?: string;
	/** When it came on screen: taken up, tabbed to, come back to, or its dismissal ended. */
	takenAt: number;
	/** Only ever set by ↑ or ↓ reaching the panel, so it says the person is choosing. */
	choice?: number;
	text: string;
	/** A send `answerPark` refused: the panel stays on this question, whatever a refresh says. */
	refused?: { message: string; question: Question };
}

/**
 * How long a question must have been up, and keys stopped, before ⏎, ↑↓ and tab reach it:
 * the time it takes to read that a question is there at all.
 */
export const KEY_PAUSE_MS = 2000;
/**
 * A ⏎ this soon after a ⏎ is a key held down or mashed, not a decision: it never sends. Long
 * enough to span a keyboard's usual delay before it repeats, short of a second-apart press.
 */
export const ENTER_REPEAT_MS = 800;

const same = (a: Ask, q: Question) =>
	a.run === q.run && a.child === q.child && a.since === q.since;
const askFor = (q: Question, now: number, first?: string): Ask => ({
	run: q.run,
	child: q.child,
	since: q.since,
	first,
	takenAt: now,
	text: "",
});

/** Every question the person can answer, oldest first: no spec claims, and no usage limits. */
export function questionsOf(home: HomeView): Question[] {
	return home.runs
		.flatMap((r) =>
			r.children.flatMap((c): Question[] =>
				c.wait?.kind === "question" && !c.wait.claim
					? [
							{
								run: r.key,
								child: c.key,
								since: c.wait.at,
								text: c.wait.text,
								summary: c.summary,
								options: c.wait.options,
								recommended: c.wait.recommended,
							},
						]
					: [],
			),
		)
		.sort((a, b) => a.since.localeCompare(b.since));
}

/** The questions in the panel's order: one run's first, when it has any, then oldest first. */
export const inOrder = (qs: Question[], first?: string): Question[] => [
	...qs.filter((q) => q.run === first),
	...qs.filter((q) => q.run !== first),
];

const setOf = (qs: Question[]) =>
	qs
		.map((q) => `${q.run}/${q.child}@${q.since}`)
		.sort()
		.join("\n");

const selectedRun = (s: ViewState, home: HomeView) =>
	selectedId(
		s,
		"home:runs",
		homeRuns(home, s).map((r) => r.key),
	);

/** The question the panel is on, once `settleAsk` has run. */
export function shownQuestion(
	s: ViewState,
	home: HomeView,
): Question | undefined {
	const a = s.ask;
	if (!a) return undefined;
	return questionsOf(home).find((q) => same(a, q)) ?? a.refused?.question;
}

/** The chosen row: the one moved to, else the one the worker recommends, else the first. */
export const chosenOf = (q: Question, a?: Ask): number =>
	a?.choice ?? q.recommended ?? 0;

export const dismissedNow = (s: ViewState, home: HomeView) =>
	s.dismissed !== undefined && s.dismissed === setOf(questionsOf(home));

/**
 * Which question the panel is on, from the questions there are now. It keeps to one while
 * that one waits. Moving the list onto another waiting run moves the panel there. When
 * its question has gone, whatever was chosen or typed goes too and the next is taken up
 * without the keys, so a key meant for the old one cannot answer the new one. Taking a
 * question up selects its run. Only Home shows the panel, so only Home settles it.
 */
export function settleAsk(
	prev: ViewState,
	home: HomeView,
	now: number,
): ViewState {
	if (prev.screen !== "home" || prev.ask?.refused) return prev;
	const qs = questionsOf(home);
	if (!qs.length)
		return prev.ask || prev.held
			? { ...prev, ask: undefined, held: undefined }
			: prev;
	// A different set of questions ends a dismissal, and the panel coming back is new to read.
	const s: ViewState =
		prev.dismissed !== undefined && prev.dismissed !== setOf(qs)
			? {
					...prev,
					dismissed: undefined,
					held: undefined,
					ask: prev.ask && { ...prev.ask, takenAt: now },
				}
			: prev;
	const sel = selectedRun(s, home);
	const on =
		sel !== undefined && qs.some((q) => q.run === sel) ? sel : undefined;
	const a = s.ask;
	if (a && qs.some((q) => same(a, q))) {
		// A kept filter can hide the question's own run: its first row is no move onto another.
		const inList = homeRuns(home, s).some((r) => r.key === a.run);
		const moved = on && on !== a.run && inList ? inOrder(qs, on)[0] : undefined;
		return moved ? { ...s, ask: askFor(moved, now, on), held: undefined } : s;
	}
	const next = inOrder(qs, on)[0];
	if (!next) return s;
	return {
		...s,
		ask: askFor(next, now, on),
		held: undefined,
		pinned: undefined,
		// A filter narrowed the list on purpose, and --select named a row: both stay.
		selection:
			s.filter || s.pinned
				? s.selection
				: { ...s.selection, "home:runs": next.run },
	};
}

/** The panel is the page's answer to a key: a question shows, and nothing is open over it. */
export function panelUp(s: ViewState, home: HomeView): boolean {
	if (s.screen !== "home" || s.overlay || s.filter?.editing || s.command)
		return false;
	return !!shownQuestion(s, home) && !dismissedNow(s, home);
}

/** The question has been up long enough to have been read, or the person is choosing on it. */
const beenRead = (s: ViewState, now: number) =>
	!s.ask || s.ask.choice !== undefined || now - s.ask.takenAt >= KEY_PAUSE_MS;

/**
 * Whether ⏎, ↑↓ and tab reach the panel. Not a mode anyone enters: it follows from the state.
 * Keys must have stopped and the question been up for the pause, and arriving does not count
 * for either. A key the panel took holds them for the next, so a typed answer never spills
 * into the list.
 */
export function panelHasKeys(
	s: ViewState,
	home: HomeView,
	now: number,
): boolean {
	if (!panelUp(s, home)) return false;
	if (s.held) return true;
	return (
		beenRead(s, now) &&
		(s.lastKeyAt === undefined || now - s.lastKeyAt >= KEY_PAUSE_MS)
	);
}

/** Whether the panel gets this key. Typing only ever types, so it needs no pause. */
export const panelTakes = (
	s: ViewState,
	k: Key,
	home: HomeView,
	now: number,
): boolean =>
	k.name === "char" || k.name === "paste"
		? panelUp(s, home)
		: panelHasKeys(s, home, now);

/** Whether ⏎ would send now, what with the pause and what there is to send. */
export function canSend(s: ViewState, home: HomeView, now: number): boolean {
	const q = shownQuestion(s, home);
	if (!q || !panelHasKeys(s, home, now) || !beenRead(s, now)) return false;
	return s.ask?.text ? !!s.ask.text.trim() : !!q.options?.length;
}

/** When the guard on ⏎ lifts, for painting the moment it does. */
export function guardEnds(s: ViewState): number {
	const up = s.ask && s.ask.choice === undefined ? s.ask.takenAt : 0;
	const keys = s.held ? 0 : (s.lastKeyAt ?? 0);
	return Math.max(up, keys) + KEY_PAUSE_MS;
}

/** A ⏎ on the heels of another, with no other key between. */
export const enterRepeats = (s: ViewState, now: number): boolean =>
	s.enterAt !== undefined && now - s.enterAt < ENTER_REPEAT_MS;

/** A send was recorded: the question and the keys both go, so the next waits for the pause. */
export const sentAsk = (s: ViewState): ViewState => ({
	...s,
	ask: undefined,
	held: undefined,
});

/** esc on the panel: the keys go to the list, and nothing about them is kept to come back to. */
const dismiss = (s: ViewState, home: HomeView, ask: Ask | undefined) => ({
	...s,
	ask: ask && { ...ask, text: "", choice: undefined },
	held: undefined,
	dismissed: setOf(questionsOf(home)),
});

/** Records a send `answerPark` refused: the panel and its text stay, with the reason. */
export function refuseAsk(
	s: ViewState,
	home: HomeView,
	message: string,
): ViewState {
	const question = shownQuestion(s, home);
	return s.ask && question
		? { ...s, ask: { ...s.ask, refused: { message, question } } }
		: s;
}

/** Where a question's text is scrolled to, and how far a page of it goes. */
export const askScrollKey = (a: Pick<Ask, "run" | "child" | "since">) =>
	`ask:${a.run}:${a.child}:${a.since}`;
export const ASK_PAGE_KEY = "ask:page";

/** A paste as plain answer text: one newline style, and no control characters but tab. */
const cleanPaste = (t: string) =>
	t
		.replace(/\r\n?/g, "\n")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/** A key the panel has: all of them but ^c and ^z, which stay with the view. */
export function panelKey(
	s: ViewState,
	k: Key,
	home: HomeView,
	now: number,
): Reduced {
	const a = s.ask;
	const q = shownQuestion(s, home);
	if (!a || !q) return { state: s, effects: [] };
	const held = { ...s, held: true };
	const st = (state: ViewState): Reduced => ({ state, effects: [] });
	const opts = q.options ?? [];
	const typing = a.text.length > 0;
	const edit = (text: string) => st({ ...held, ask: { ...a, text } });
	const send = (text: string): Effect => ({
		kind: "answer",
		run: a.run,
		child: a.child,
		since: a.since,
		text,
	});
	switch (k.name) {
		case "esc": {
			if (typing && opts.length) return edit("");
			// A refused question may have gone: nothing is left to hold it open for.
			return st(dismiss(s, home, a.refused ? undefined : a));
		}
		case "enter": {
			// Typed text too: `j j ⏎` meant for the list shows as text, and is still unread.
			const text = typing ? a.text.trim() : opts[chosenOf(q, a)];
			if (!text || !beenRead(s, now) || enterRepeats(s, now)) return st(s);
			return { state: held, effects: [send(text)] };
		}
		case "up":
		case "down": {
			if (typing || !opts.length) return st(held);
			const by = k.name === "up" ? -1 : 1;
			const choice = Math.min(
				opts.length - 1,
				Math.max(0, chosenOf(q, a) + by),
			);
			return st({ ...held, ask: { ...a, choice } });
		}
		case "tab": {
			if (typing) return st(held);
			const order = inOrder(questionsOf(home), a.first);
			const next =
				order[(order.findIndex((x) => same(a, x)) + 1) % order.length];
			if (!next || same(a, next)) return st(held);
			return st({
				...held,
				ask: askFor(next, now, a.first),
				selection: s.filter
					? s.selection
					: { ...s.selection, "home:runs": next.run },
			});
		}
		case "pgup":
		case "pgdn": {
			const key = askScrollKey(a);
			const page = s.scroll[ASK_PAGE_KEY] ?? 1;
			const at = (s.scroll[key] ?? 0) + (k.name === "pgup" ? -page : page);
			return st({ ...held, scroll: { ...s.scroll, [key]: Math.max(0, at) } });
		}
		case "backspace":
			return edit([...a.text].slice(0, -1).join(""));
		case "char":
			return edit(a.text + (k.ch ?? ""));
		case "paste": {
			const text = cleanPaste(k.text ?? "");
			return text ? edit(a.text + text) : st(s);
		}
		default:
			return st(held);
	}
}

/**
 * ⏎ and esc on Home's list while a question shows and the keys are still the list's.
 * After esc, ⏎ on a waiting run's row comes back to its question, and starts the pause
 * rather than ending it. In the pause before a question takes the keys, ⏎ does nothing:
 * held down, or pressed twice, it must not reach the question. Undefined leaves the key
 * to the list.
 */
export function listKeyOnQuestion(
	s: ViewState,
	k: Key,
	home: HomeView,
	now: number,
): ViewState | undefined {
	if (
		s.screen !== "home" ||
		s.overlay ||
		s.filter?.editing ||
		s.command ||
		!s.ask
	)
		return undefined;
	const dismissed = dismissedNow(s, home);
	if (k.name === "esc") return dismissed ? undefined : dismiss(s, home, s.ask);
	if (k.name !== "enter") return undefined;
	const sel = selectedRun(s, home);
	const q = inOrder(questionsOf(home), sel)[0];
	if (!q || q.run !== sel) return undefined;
	if (!dismissed) return s;
	return {
		...s,
		dismissed: undefined,
		ask: s.ask.run === sel ? { ...s.ask, takenAt: now } : askFor(q, now, sel),
	};
}
