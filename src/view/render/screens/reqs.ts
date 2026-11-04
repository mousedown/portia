import type { Ctx } from "../common";
import { type Span, sp, strWidth } from "../text";

type Req = { id: string; ok: boolean };

/** Only a child that has finished can have failed to prove something; before that, ✗ is "not yet". */
export const settled = (state: string | undefined) =>
	state === "landed" || state === "failed" || state === "closed";

/** A child's requirements in at most `cap` cells: every id, else the ones that fit and `+N`, else a count. */
export function reqFit(
	ctx: Ctx,
	reqs: Req[],
	cap: number,
	final = true,
): { spans: Span[]; width: number } {
	// Unproven is not failed: before the child has finished a miss is a faint ·.
	const miss = final ? "failed" : "faint";
	const missMark = final ? ctx.g.cross : ctx.g.dot;
	const one = (q: Req): Span[] => [
		{ text: `${q.id} `, role: "accent" },
		{
			text: q.ok ? ctx.g.check : missMark,
			role: q.ok ? "landed" : miss,
		},
	];
	const widthOf = (q: Req) => strWidth(q.id) + 2;
	const full = reqs.reduce((n, q, i) => n + (i ? 1 : 0) + widthOf(q), 0);
	const join = (list: Req[]) =>
		list.flatMap((q, i) => (i ? [sp(1), ...one(q)] : one(q)));
	if (full <= cap) return { spans: join(reqs), width: full };
	if (reqs.every((q) => q.ok === reqs[0]?.ok)) {
		const ok = reqs[0]?.ok ?? true;
		const text = `${reqs.length} `;
		return {
			spans: [
				{ text, role: "accent" },
				{
					text: ok ? ctx.g.check : missMark,
					role: ok ? "landed" : miss,
				},
			],
			width: text.length + 1,
		};
	}
	// Failures first: they are the ids a reader is looking for.
	const order = [...reqs.filter((q) => !q.ok), ...reqs.filter((q) => q.ok)];
	const shown: Req[] = [];
	let used = 0;
	for (const q of order) {
		const rest = order.length - shown.length - 1;
		const tail = rest ? ` +${rest}`.length : 0;
		const add = (shown.length ? 1 : 0) + widthOf(q);
		if (used + add + tail > cap) break;
		shown.push(q);
		used += add;
	}
	const hidden = reqs.length - shown.length;
	const more = `${shown.length ? " " : ""}+${hidden}`;
	return {
		spans: [...join(shown), { text: more, role: "dim" }],
		width: used + more.length,
	};
}
