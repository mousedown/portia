import {
	ASK_PAGE_KEY,
	askScrollKey,
	chosenOf,
	inOrder,
	type Question,
	questionsOf,
} from "../../runtime/ask";
import { type Ctx, home, rule } from "../common";
import {
	type Line,
	lineWidth,
	lr,
	type Span,
	sp,
	strWidth,
	truncate,
	wrap,
} from "../text";

/** The list's key column: the dock's key and marks start here, a child's glyph two before. */
export const DOCK_AT = 4;
const RECOMMENDED = " (recommended)";

/** A worker's text is free text: nothing in it may reach the terminal as a control. */
const printable = (t: string) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	t.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");

/** The fewest rows the panel can show itself in: its head, a line and a marker, the choices and the typing line. */
export const askPanelLeast = (q: Question) => 4 + (q.options?.length ?? 0);

function optionRow(
	ctx: Ctx,
	text: string,
	i: number,
	o: {
		chosen: boolean;
		recommended: boolean;
		focused: boolean;
		typing: boolean;
	},
): Line {
	const lead = DOCK_AT + 3;
	const tail = o.recommended ? strWidth(RECOMMENDED) : 0;
	const room = Math.max(4, ctx.W - lead - tail);
	const role = o.typing ? "dim" : o.chosen ? "ink" : "ink2";
	const cursor: Span =
		o.chosen && !o.typing
			? { text: ctx.g.pointer, role: o.focused ? "accent" : "dim" }
			: sp(1);
	return [
		sp(DOCK_AT - 2),
		cursor,
		sp(1),
		{ text: String(i + 1), role: "dim" },
		sp(2),
		...truncate(
			[
				{
					text: printable(text).replace(/\s+/g, " "),
					role,
					bold: o.chosen && !o.typing,
				},
			],
			room,
		),
		...(tail ? [{ text: RECOMMENDED, role: "dim" as const }] : []),
	];
}

/**
 * The question waiting, in the dock's place: whose it is, the whole of it, the worker's
 * choices and the line that takes a typed answer. In `room` rows the choices and that line
 * always show; the rule and the gap go first, then the question scrolls inside the panel.
 */
export function askPanel(
	ctx: Ctx,
	q: Question,
	listK: number,
	focused: boolean,
	room = Number.POSITIVE_INFINITY,
): Line[] {
	const a = ctx.state.ask;
	const typed = a?.text ?? "";
	const typing = typed.length > 0;
	const opts = q.options ?? [];
	const chosen = chosenOf(q, a);
	const w = Math.max(10, ctx.W - DOCK_AT);
	const order = inOrder(questionsOf(home(ctx)), a?.first);
	const at = order.findIndex(
		(x) => x.run === q.run && x.child === q.child && x.since === q.since,
	);
	const place: Line =
		at >= 0 ? [{ text: `${at + 1} of ${order.length}`, role: "dim" }] : [];
	const left: Line = [
		sp(DOCK_AT),
		{ text: q.child.padEnd(listK), role: "ink", bold: true },
		...(q.summary ? [sp(2), { text: q.summary, role: "ink2" as const }] : []),
	];
	const head = lr(truncate(left, ctx.W - lineWidth(place) - 2), place, ctx.W);
	const question = wrap(printable(q.text), w);
	const answer = typing ? wrap(`${typed}${ctx.g.caret}`, w) : [];
	const refused = a?.refused?.message;

	// What always shows: the head, the choices, and the typing line.
	const decor = 2;
	const fixed = 1 + opts.length;
	const answerRows = Math.max(1, answer.length);
	const whole =
		fixed + answerRows + question.length + (refused ? 1 : 0) + decor <= room;
	const roomy = whole || room >= fixed + 1 + 4 + decor;
	const free = room - fixed - (roomy ? decor : 0);
	const answerShown = whole
		? answerRows
		: Math.min(answerRows, Math.max(1, Math.floor((free - 2) / 2)));
	const left4q = free - answerShown;
	const overflow = !whole && question.length + (refused ? 1 : 0) > left4q;
	const view = whole
		? question.length
		: overflow
			? Math.max(1, left4q - 1)
			: question.length;

	const key = a ? askScrollKey(a) : "";
	const from = Math.min(
		Math.max(0, question.length - view),
		ctx.state.scroll[key] ?? 0,
	);
	if (a) {
		ctx.scroll[key] = from;
		ctx.scroll[ASK_PAGE_KEY] = Math.max(1, view);
	}
	const above = from;
	const below = question.length - from - view;
	const marker: Line = refused
		? truncate(
				[sp(DOCK_AT), { text: printable(refused), role: "failed" }],
				ctx.W,
			)
		: above || below
			? lr(
					[],
					[
						...(above
							? [
									{
										text: `${ctx.g.up} ${above} more`,
										role: "dim" as const,
									},
								]
							: []),
						...(above && below ? [sp(2)] : []),
						...(below
							? [
									{
										text: `${ctx.g.down} ${below} more`,
										role: "dim" as const,
									},
								]
							: []),
					],
					ctx.W,
				)
			: [];

	const typingLine: Line[] = typing
		? answer
				.slice(-answerShown)
				.map((l): Line => [sp(DOCK_AT), { text: l, role: "ink" }])
		: [
				[
					sp(DOCK_AT),
					{
						text: opts.length
							? "or just type your own answer"
							: "type your answer",
						role: "dim",
					},
				],
			];
	return [
		...(roomy ? [rule(ctx)] : []),
		head,
		...question
			.slice(from, from + view)
			.map((l): Line => [sp(DOCK_AT), { text: l, role: "ink" }]),
		...(refused || above || below ? [marker] : []),
		...(roomy ? [[] as Line] : []),
		...opts.map((o, i) =>
			optionRow(ctx, o, i, {
				chosen: i === chosen,
				recommended: i === q.recommended,
				focused,
				typing,
			}),
		),
		...typingLine,
	];
}
