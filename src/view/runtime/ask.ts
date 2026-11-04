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
	choice?: number;
	text: string;
	/** A send `answerPark` refused: the panel stays on this question, whatever a refresh says. */
	refused?: { message: string; question: Question };
}

/** How long keys must stop before a question that arrived while they were pressed takes them. */
export const KEY_PAUSE_MS = 2000;

const same = (a: Ask, q: Question) =>
	a.run === q.run && a.child === q.child && a.since === q.since;
const askFor = (q: Question, first?: string): Ask => ({
	run: q.run,
	child: q.child,
	since: q.since,
	first,
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
export function settleAsk(s: ViewState, home: HomeView): ViewState {
	if (s.screen !== "home" || s.ask?.refused) return s;
	const qs = questionsOf(home);
	if (!qs.length)
		return s.ask || s.held ? { ...s, ask: undefined, held: undefined } : s;
	const sel = selectedRun(s, home);
	const on =
		sel !== undefined && qs.some((q) => q.run === sel) ? sel : undefined;
	const a = s.ask;
	if (a && qs.some((q) => same(a, q))) {
		const moved = on && on !== a.run ? inOrder(qs, on)[0] : undefined;
		return moved ? { ...s, ask: askFor(moved, on) } : s;
	}
	const next = inOrder(qs, on)[0];
	if (!next) return s;
	return {
		...s,
		ask: askFor(next, on),
		held: a ? undefined : s.held,
		// A filter narrowed the list on purpose: the question's run may not be in it.
		selection: s.filter
			? s.selection
			: { ...s.selection, "home:runs": next.run },
	};
}

/**
 * Whether the panel has the keys. Not a mode anyone enters: it follows from the state. A
 * key the panel took holds them for the next, so a typed answer never spills into the list.
 */
export function panelHasKeys(
	s: ViewState,
	home: HomeView,
	now: number,
): boolean {
	if (s.screen !== "home" || s.overlay || s.filter || s.command) return false;
	if (!shownQuestion(s, home) || dismissedNow(s, home)) return false;
	return (
		!!s.held || s.lastKeyAt === undefined || now - s.lastKeyAt >= KEY_PAUSE_MS
	);
}

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
export function panelKey(s: ViewState, k: Key, home: HomeView): Reduced {
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
			if (typing && opts.length && !a.refused) return edit("");
			// A refused question may have gone: nothing is left to hold it open for.
			const base: ViewState = a.refused
				? { ...s, ask: undefined }
				: { ...s, ask: { ...a, text: "" } };
			return st({
				...base,
				held: undefined,
				dismissed: setOf(questionsOf(home)),
			});
		}
		case "enter": {
			const text = typing ? a.text.trim() : opts[chosenOf(q, a)];
			return text ? { state: held, effects: [send(text)] } : st(held);
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
				ask: askFor(next, a.first),
				selection: { ...s.selection, "home:runs": next.run },
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
		case "paste":
			return edit(a.text + cleanPaste(k.text ?? ""));
		default:
			return st(held);
	}
}

/**
 * ⏎ and esc on Home's list while a question shows and the keys are still the list's.
 * After esc, ⏎ on a waiting run's row takes the keys back for its question. In the pause
 * before a new question takes the keys, ⏎ does nothing: held down, or pressed twice, it
 * must not reach the question. Undefined leaves the key to the list.
 */
export function listKeyOnQuestion(
	s: ViewState,
	k: Key,
	home: HomeView,
): ViewState | undefined {
	if (s.screen !== "home" || s.overlay || s.filter || s.command || !s.ask)
		return undefined;
	const dismissed = dismissedNow(s, home);
	if (k.name === "esc")
		return dismissed
			? undefined
			: { ...s, held: undefined, dismissed: setOf(questionsOf(home)) };
	if (k.name !== "enter") return undefined;
	const sel = selectedRun(s, home);
	const q = inOrder(questionsOf(home), sel)[0];
	if (!q || q.run !== sel) return undefined;
	if (!dismissed) return s;
	return {
		...s,
		dismissed: undefined,
		held: true,
		ask: s.ask.run === sel ? s.ask : askFor(q, sel),
	};
}
