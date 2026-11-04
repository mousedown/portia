import type { ChildState, Lane, ParentPlan } from "../core/types";
import type { Slots } from "../env/slots";
import { fit, paint, type Style } from "./style";

export interface StatusChild {
	key: string;
	summary: string;
	state: ChildState;
	lane?: Lane;
}
export interface StatusView {
	parent: { key: string; summary: string };
	waves: { wave: number; children: StatusChild[] }[];
	edges: { from: string; to: string; reason: string }[];
	slots?: Slots;
}

const GLYPH: Record<ChildState, [string, string, number]> = {
	pending: ["·", ".", 2],
	ready: ["○", "o", 0],
	running: ["◐", "~", 36],
	parked: ["!", "!", 33],
	failed: ["✗", "x", 31],
	done: ["●", "*", 32],
	landed: ["✓", "+", 32],
	closed: ["–", "-", 2],
};
const KEY = 9;
const STATE = 8;
const LANE = 5;

export function toView(
	plan: ParentPlan,
	states: Map<string, ChildState>,
	{ lanes, slots }: { lanes?: Map<string, Lane>; slots?: Slots } = {},
): StatusView {
	const waves = [...new Set(plan.children.map((c) => c.wave))]
		.sort((a, b) => a - b)
		.map((wave) => ({
			wave,
			children: plan.children
				.filter((c) => c.wave === wave)
				.map((c) => ({
					key: c.key,
					summary: c.summary,
					state: states.get(c.key) ?? "pending",
					lane: lanes?.get(c.key),
				})),
		}));
	const edges = plan.children.flatMap((c) =>
		c.needs.map((n) => ({ from: n.key, to: c.key, reason: n.reason })),
	);
	return {
		parent: { key: plan.key, summary: plan.summary },
		waves,
		edges,
		...(slots ? { slots } : {}),
	};
}

export function renderStatus(v: StatusView, st: Style): string {
	const dot = st.unicode ? "·" : "-";
	const arrow = st.unicode ? "→" : "->";
	const out = [
		fit(`  ${v.parent.key}  ${v.parent.summary}`, st.width, st).trimEnd(),
	];
	if (v.slots) {
		const s = v.slots;
		out.push(
			fit(
				`  slots  ${s.available} of ${s.cap} free ${dot} ${s.used} running here ${dot} ${s.peers} in other runs ${dot} memory fits ${s.memory}`,
				st.width,
				st,
			).trimEnd(),
		);
	}
	for (const w of v.waves) {
		const landed = w.children.filter((c) => c.state === "landed").length;
		out.push(
			"",
			fit(
				`  wave ${w.wave} ${dot} ${landed}/${w.children.length} landed`,
				st.width,
				st,
			).trimEnd(),
		);
		for (const c of w.children) {
			const [u, a, colour] = GLYPH[c.state];
			const glyph = st.unicode ? u : a;
			const lane = c.lane ? ` ${c.lane.padEnd(LANE)}` : "";
			const summaryWidth =
				st.width - (3 + 1 + 1 + KEY + 1 + 1 + STATE + lane.length);
			const rest =
				` ${c.key.padEnd(KEY)} ${fit(c.summary, summaryWidth, st)} ${c.state.padEnd(STATE)}${lane}`.trimEnd();
			out.push(`   ${paint(glyph, colour, st)}${rest}`);
		}
	}
	if (v.edges.length) {
		out.push("", "  edges");
		for (const e of v.edges)
			out.push(
				fit(
					`   ${e.from} ${arrow} ${e.to}  ${e.reason}`,
					st.width,
					st,
				).trimEnd(),
			);
	}
	return out.join("\n");
}
