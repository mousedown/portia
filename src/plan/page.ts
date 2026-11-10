import { waitEdges } from "../core/plan-edges";
import type { ChildPlan, Need, ParentPlan, Scenario } from "../core/types";

/**
 * The plan as a page to publish: the waves drawn as a map of cards with each need as a line,
 * then every child with what it builds on and the scenarios it delivers. Hovering a card
 * lights what it waits on and what it unblocks. It is the plan as the tickets hold it, so it
 * carries no progress, and like everything outward it never names the tool.
 */

const NODE_W = 176;
const NODE_H = 66;
const ROW_GAP = 14;
const COL_GAP = 52;
const HEAD = 48;
const PAD = 16;

const esc = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const waveName = (w: number) => (w === 0 ? "Spine" : `Wave ${w}`);
const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

function wavesOf(plan: ParentPlan): [number, ChildPlan[]][] {
	const waves = [...new Set(plan.children.map((c) => c.wave))].sort(
		(a, b) => a - b,
	);
	return waves.map((w) => [w, plan.children.filter((c) => c.wave === w)]);
}

/**
 * Each wave's children ordered by where the children they wait on sit, so lines cross less.
 * A child waiting only on the spine keeps its place.
 */
function ordered(
	waves: [number, ChildPlan[]][],
	edges: Map<string, string[]>,
	spine: Set<string>,
): [number, ChildPlan[]][] {
	const row = new Map<string, number>();
	return waves.map(([w, list]) => {
		const keyed = list.map((c, i) => {
			const from = (edges.get(c.key) ?? []).filter((k) => !spine.has(k));
			const rows = from
				.map((k) => row.get(k))
				.filter((r): r is number => r !== undefined);
			const bary = rows.length
				? rows.reduce((a, b) => a + b, 0) / rows.length
				: i;
			return { c, bary, i };
		});
		keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
		keyed.forEach(({ c }, r) => {
			row.set(c.key, r);
		});
		return [w, keyed.map(({ c }) => c)];
	});
}

/** A scenario's Given, When and Then, when it is written that way; its Then split at each ", and". */
export function splitScenario(
	text: string,
): { given: string; when?: string; outcomes: string[] } | undefined {
	const m =
		/^Given\s+([\s\S]*?)(?:,\s*When\s+([\s\S]*?))?,\s*Then\s+([\s\S]*)$/.exec(
			text.trim(),
		);
	const [, given = "", when, rest = ""] = m ?? [];
	if (!m) return undefined;
	const parts = rest
		.split(/,\s+and\s+(?=[a-z])/)
		.map((p) => p.trim())
		.filter(Boolean);
	const outcomes =
		parts.length > 1 && parts.every((p) => p.length > 12)
			? parts
			: [rest.trim()];
	return { given: given.trim(), when: when?.trim(), outcomes };
}

/** The line a scenario is known by at a glance: its When, else its Given, else its start. */
export function headline(text: string): string {
	const s = splitScenario(text);
	if (s?.when) return `When ${s.when}`;
	if (s) return `Given ${s.given}`;
	return text;
}

/** Needs sharing a reason, as one group: nineteen "ships once it has landed" read as one line. */
export function groupNeeds(
	needs: Need[],
): { keys: string[]; reason: string }[] {
	const groups = new Map<string, string[]>();
	for (const n of needs) {
		const keys = groups.get(n.reason) ?? [];
		keys.push(n.key);
		groups.set(n.reason, keys);
	}
	return [...groups].map(([reason, keys]) => ({ keys, reason }));
}

/** Escaped text with procedure names, identifiers and constants set in code. */
function prose(s: string): string {
	return esc(s).replace(
		/\b([a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9_]*)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g,
		"<code>$1</code>",
	);
}

const sizeOf = (c: ChildPlan) => c.size?.trim().toUpperCase() || undefined;

function diagram(plan: ParentPlan): string {
	const edges = waitEdges(plan.children);
	const spine = new Set(
		plan.children.filter((c) => c.wave === 0).map((c) => c.key),
	);
	const waves = ordered(wavesOf(plan), edges, spine);
	const tallest = Math.max(...waves.map(([, l]) => l.length));
	const colX = (i: number) => PAD + i * (NODE_W + COL_GAP);
	const rowY = (i: number) => HEAD + i * (NODE_H + ROW_GAP);
	const width = colX(waves.length - 1) + NODE_W + PAD;
	const height = rowY(tallest - 1) + NODE_H + PAD;
	const at = new Map<string, { x: number; y: number }>();
	waves.forEach(([, list], col) => {
		list.forEach((c, row) => {
			at.set(c.key, { x: colX(col), y: rowY(row) });
		});
	});
	// Laid out at a design width, then placed in percentages so the map fits its column.
	const pct = (n: number, of = width) => `${+((n / of) * 100).toFixed(3)}%`;
	const BAND = NODE_W + 20;
	const lines: string[] = [];
	for (const [key, needs] of edges)
		for (const need of needs) {
			const a = at.get(need);
			const b = at.get(key);
			if (!a || !b) continue;
			const x1 = a.x + NODE_W;
			const y1 = a.y + NODE_H / 2;
			const x2 = b.x;
			const y2 = b.y + NODE_H / 2;
			const mid = x1 + Math.min((x2 - x1) / 2, COL_GAP * 0.9);
			const end = x2 - Math.min((x2 - x1) / 2, COL_GAP * 0.9);
			lines.push(
				`<path class="edge"${spine.has(need) ? " data-spine" : ""} data-from="${esc(need)}" data-to="${esc(key)}" d="M${x1} ${y1} C${mid} ${y1} ${end} ${y2} ${x2} ${y2}"/>`,
			);
		}
	const node = (c: ChildPlan) => {
		const p = at.get(c.key);
		if (!p) return "";
		const size = sizeOf(c);
		return `<a class="node${c.wave === 0 ? " spine" : ""}" href="#${esc(c.key)}" data-key="${esc(c.key)}" style="top:${p.y - 6}px;height:${NODE_H}px" aria-label="${esc(`${c.key}: ${c.summary}`)}"><span class="node-top"><span class="node-key">${esc(c.key)}</span>${c.tier === "high" ? '<span class="tier" title="High tier">◆</span>' : ""}${size ? `<span class="size">${esc(size)}</span>` : ""}</span><span class="node-sum">${esc(c.summary)}</span></a>`;
	};
	const cols = waves
		.map(
			([w, list], col) =>
				`<div class="wave-col${w === 0 ? " spine" : ""}" style="left:${pct(colX(col) - 10)};width:${pct(BAND)};--inset:${pct(10, BAND)}"><div class="wave-head"><span class="wave-name">${waveName(w)}</span><span class="wave-count">${list.length}</span></div>${list.map(node).join("")}</div>`,
		)
		.join("");
	return `<div class="map" style="--h:${height}px"><svg aria-hidden="true" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><g class="edges">${lines.join("")}</g></svg>${cols}<div class="tip" id="tip" role="status" hidden></div></div>`;
}

function scenarioRow(id: string, text: string | undefined): string {
	if (text === undefined)
		return `<div class="scn missing" data-text="${esc(id.toLowerCase())}"><span class="sid">${esc(id)}</span><span class="scn-head">No scenario text in the plan</span></div>`;
	const s = splitScenario(text);
	const body = s
		? `<dl class="gwt"><dt>Given</dt><dd>${prose(s.given)}</dd>${s.when ? `<dt>When</dt><dd>${prose(s.when)}</dd>` : ""}<dt>Then</dt><dd>${s.outcomes.length > 1 ? `<ul>${s.outcomes.map((t) => `<li>${prose(t)}</li>`).join("")}</ul>` : prose(s.outcomes[0] ?? "")}</dd></dl>`
		: `<p class="gwt-plain">${prose(text)}</p>`;
	return `<details class="scn" data-text="${esc(`${id} ${text}`.toLowerCase())}"><summary><span class="sid">${esc(id)}</span><span class="scn-head">${prose(headline(text))}</span></summary>${body}</details>`;
}

function needsBlock(c: ChildPlan): string {
	if (!c.needs.length)
		return c.wave === 0
			? `<p class="quiet">The spine lands first. Every other child builds on it.</p>`
			: `<p class="quiet">Builds on the spine alone.</p>`;
	const groups = groupNeeds(c.needs)
		.map((g) => {
			const chips = g.keys
				.map((k) => `<a class="chip" href="#${esc(k)}">${esc(k)}</a>`)
				.join("");
			const keys =
				g.keys.length > 5
					? `<details class="many"><summary>${plural(g.keys.length, "child", "children")}</summary><span class="chips">${chips}</span></details>`
					: `<span class="chips">${chips}</span>`;
			return `<li>${keys}<p>${prose(g.reason)}</p></li>`;
		})
		.join("");
	return `<ul class="needs">${groups}</ul>`;
}

function card(c: ChildPlan, texts: Map<string, string>): string {
	const size = sizeOf(c);
	const facts = [
		size ? `<span class="pill">${esc(size)}</span>` : "",
		c.tier === "high" ? `<span class="pill high">◆ High tier</span>` : "",
		`<span class="pill">${plural(c.touches.length, "path")}</span>`,
	].join("");
	const scen = c.requirements.length
		? `<div class="scns">${c.requirements.map((r) => scenarioRow(r, texts.get(r))).join("")}</div>`
		: `<p class="quiet">No scenarios of its own.</p>`;
	const text = [c.key, c.summary, ...c.requirements].join(" ").toLowerCase();
	return `<article id="${esc(c.key)}" class="child${c.wave === 0 ? " spine" : ""}" data-key="${esc(c.key)}" data-text="${esc(text)}"><header class="child-head"><code class="child-key">${esc(c.key)}</code><h3>${esc(c.summary)}</h3><span class="facts">${facts}</span></header><div class="child-body"><div class="col"><h4>Builds on</h4>${needsBlock(c)}</div><div class="col"><h4>Delivers ${plural(c.requirements.length, "scenario")}</h4>${scen}</div></div></article>`;
}

const STYLE = `
/* A drafting table: the wave map is the drawing, the children below are its key. */
:root {
	--bg: #f4f3f7; --surface: #ffffff; --sunk: #ebe9f1; --ink: #1d1a29; --ink2: #5d5870; --ink3: #8d88a0;
	--line: #d9d5e3; --grid: #d6d2e1;
	--accent: #7b2d63; --accent-soft: #f3e4ee; --on-accent: #fff7fb;
	--up: #1f6f8b; --up-soft: #dcedf3; --down: #b4571d; --down-soft: #f8e6d8;
	--shadow: rgba(29, 26, 41, .08);
	--display: "Bricolage Grotesque", "IBM Plex Sans", system-ui, sans-serif;
	--sans: "IBM Plex Sans", system-ui, sans-serif;
	--mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		--bg: #121019; --surface: #1c1926; --sunk: #17141f; --ink: #ece9f4; --ink2: #a29db5; --ink3: #6f6a84;
		--line: #332e42; --grid: #2b2639;
		--accent: #e49ac8; --accent-soft: #3a2133; --on-accent: #22101c;
		--up: #6cc3e0; --up-soft: #16313b; --down: #f0a46c; --down-soft: #3b2617;
		--shadow: rgba(0, 0, 0, .4);
		color-scheme: dark;
	}
}
:root[data-theme="dark"] {
	--bg: #121019; --surface: #1c1926; --sunk: #17141f; --ink: #ece9f4; --ink2: #a29db5; --ink3: #6f6a84;
	--line: #332e42; --grid: #2b2639;
	--accent: #e49ac8; --accent-soft: #3a2133; --on-accent: #22101c;
	--up: #6cc3e0; --up-soft: #16313b; --down: #f0a46c; --down-soft: #3b2617;
	--shadow: rgba(0, 0, 0, .4);
	color-scheme: dark;
}
* { box-sizing: border-box; }
body {
	background: var(--bg); color: var(--ink); font: 15px/1.55 var(--sans);
	padding-left: max(16px, env(safe-area-inset-left, 0px));
	padding-right: max(16px, env(safe-area-inset-right, 0px));
	padding-block: 40px 72px;
}
main { max-width: 1240px; margin-inline: auto; display: grid; gap: 44px; }
main > * { min-width: 0; }
code { font: 500 .88em var(--mono); background: var(--sunk); padding: 0 .3em; border-radius: 3px; overflow-wrap: anywhere; }
a { color: inherit; }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Header */
.top { display: grid; gap: 10px; }
.eyebrow { font: 500 12px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin: 0; }
h1 { font: 700 clamp(28px, 4vw, 40px)/1.08 var(--display); letter-spacing: -.02em; margin: 0; text-wrap: balance; max-width: 26ch; }
.meta { color: var(--ink2); margin: 0; max-width: 70ch; }
.stats { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 6px 0 0; padding: 0; }
.stats div { display: grid; gap: 0; }
.stats dt { font: 500 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink3); }
.stats dd { margin: 0; font: 600 22px/1.2 var(--display); font-variant-numeric: tabular-nums; }
.stats dd small { font: 400 13px var(--mono); color: var(--ink2); margin-left: 2px; }

/* Section headings */
.sec { display: grid; gap: 14px; }
.sec-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; }
h2 { font: 600 20px/1.2 var(--display); letter-spacing: -.01em; margin: 0; }
h2 .n { font: 400 13px var(--mono); color: var(--ink2); margin-left: 8px; letter-spacing: 0; }

/* Legend and controls */
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 18px; font-size: 13px; color: var(--ink2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--line); background: var(--surface); }
.sw.spine { background: var(--accent); border-color: var(--accent); }
.ln { width: 18px; height: 0; border-top: 2px solid; }
.ln.up { border-color: var(--up); } .ln.down { border-color: var(--down); }
.legend .dia { color: var(--accent); }
.btn { font: 500 12px var(--sans); color: var(--ink2); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; cursor: pointer; }
.btn:hover { color: var(--ink); border-color: var(--ink3); }
.btn[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }

/* The map */
.drawing {
	border: 1px solid var(--line); border-radius: 12px; padding: 8px;
	background-color: var(--surface);
	background-image: radial-gradient(var(--grid) 1px, transparent 1.2px);
	background-size: 16px 16px;
	box-shadow: 0 1px 2px var(--shadow), 0 8px 28px var(--shadow);
}
/* Wide: columns placed in percentages at a fixed height, lines stretched to match. */
.map { position: relative; height: var(--h); }
.map svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; overflow: visible; }
.wave-col { position: absolute; top: 6px; bottom: 6px; border-radius: 10px; background: color-mix(in srgb, var(--sunk) 70%, transparent); }
.wave-col.spine { background: var(--accent-soft); }
.edge { fill: none; stroke: var(--ink3); stroke-opacity: .5; stroke-width: 1.25; vector-effect: non-scaling-stroke; transition: stroke-opacity .2s, stroke .2s; }
.edge[data-spine] { stroke-dasharray: 3 4; stroke-opacity: .32; }
.no-spine .edge[data-spine] { stroke-opacity: 0; }
.wave-head { position: absolute; top: 8px; left: var(--inset); right: var(--inset); display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.wave-name { font: 600 13px var(--display); letter-spacing: .01em; white-space: nowrap; }
.wave-col.spine .wave-name { color: var(--accent); }
.wave-count { font: 500 11px var(--mono); color: var(--ink3); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; }
.node {
	position: absolute; left: var(--inset); right: var(--inset); z-index: 1;
	display: grid; grid-template-rows: auto 1fr; gap: 3px;
	padding: 8px 10px; text-decoration: none; color: var(--ink);
	background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
	box-shadow: 0 1px 2px var(--shadow);
	transition: opacity .2s, transform .2s, border-color .2s, box-shadow .2s;
}
.node:hover, .node:focus-visible { border-color: var(--ink2); transform: translateY(-1px); box-shadow: 0 6px 18px var(--shadow); outline: none; }
.node-top { display: flex; align-items: center; gap: 6px; }
.node-key { font: 500 11.5px var(--mono); letter-spacing: .01em; }
.tier { color: var(--accent); font-size: 10px; }
.size { margin-left: auto; font: 500 10px var(--mono); color: var(--ink2); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
.node-sum { font-size: 12px; line-height: 1.35; color: var(--ink2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.node.spine { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.node.spine .node-sum, .node.spine .tier, .node.spine .size { color: var(--on-accent); }
.node.spine .size { border-color: var(--on-accent); opacity: .8; }

/* Focus: what this waits on, and what waits on it */
.map.focus .node { opacity: .28; }
.map.focus .node.is-self, .map.focus .node.is-up, .map.focus .node.is-down { opacity: 1; }
.map.focus .node.is-self { border-color: var(--ink); box-shadow: 0 0 0 3px var(--ink), 0 10px 26px var(--shadow); }
.map.focus .node.spine.is-self { box-shadow: 0 0 0 3px var(--ink), 0 10px 26px var(--shadow); }
.map.focus .node.is-up:not(.spine) { border-color: var(--up); background: var(--up-soft); }
.map.focus .node.is-down { border-color: var(--down); background: var(--down-soft); }
.map.focus .edge { stroke-opacity: .07; }
.map.focus .edge.is-up { stroke: var(--up); stroke-opacity: .95; stroke-width: 2; stroke-dasharray: 6 5; animation: flow 1s linear infinite; }
.map.focus .edge.is-down { stroke: var(--down); stroke-opacity: .95; stroke-width: 2; stroke-dasharray: 6 5; animation: flow 1s linear infinite; }
.map .node.miss { opacity: .18; }
@keyframes flow { to { stroke-dashoffset: -11; } }
/* Narrow: no lines; each wave becomes a band of cards, read top to bottom. */
@media (max-width: 860px) {
	.map { height: auto; display: grid; gap: 8px; }
	.map svg { display: none; }
	.wave-col { position: static; padding: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 190px), 1fr)); gap: 8px; }
	.wave-head { position: static; grid-column: 1 / -1; }
	.node { position: static; height: auto !important; min-height: 64px; }
}

.tip {
	position: absolute; z-index: 5; width: 280px; pointer-events: none;
	background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 10px;
	box-shadow: 0 12px 32px var(--shadow); padding: 12px 14px; display: grid; gap: 8px; font-size: 13px;
}
.tip-top { display: flex; align-items: center; gap: 8px; font: 500 11px var(--mono); color: var(--ink2); }
.tip-top b { color: var(--ink); font-weight: 500; font-size: 12px; }
.tip-sum { font: 600 14px/1.3 var(--display); }
.tip-rel { display: flex; gap: 14px; font-size: 12px; }
.tip-rel span { display: inline-flex; align-items: center; gap: 6px; }
.tip-rel i { width: 8px; height: 8px; border-radius: 50%; }
.tip-rel .u i { background: var(--up); } .tip-rel .d i { background: var(--down); }
.tip-why { color: var(--ink2); font-size: 12px; line-height: 1.45; margin: 0; }
.tip-ids { display: flex; flex-wrap: wrap; gap: 4px; }
.tip-ids span { font: 500 11px var(--mono); color: var(--accent); background: var(--accent-soft); border-radius: 4px; padding: 0 6px; }

/* Children and their scenarios */
.tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.search { font: 14px var(--sans); color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 6px 14px; width: min(320px, 100%); }
.search::placeholder { color: var(--ink3); }
.found { font: 12px var(--mono); color: var(--ink3); }
.wave-tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 6px; }
.wtab {
	display: grid; gap: 6px; text-align: left; cursor: pointer; color: var(--ink);
	background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
	transition: background .2s, border-color .2s, color .2s;
}
.wtab:hover { border-color: var(--ink3); }
.wtab-name { font: 600 14px/1.2 var(--display); }
.wtab.spine .wtab-name { color: var(--accent); }
.wtab-meta { font: 11px var(--mono); color: var(--ink3); }
.dots { display: flex; flex-wrap: wrap; gap: 3px; }
.dots i { width: 7px; height: 7px; border-radius: 2px; background: var(--line); }
.dots i.h { background: var(--accent); }
.wtab[aria-selected="true"] { background: var(--ink); border-color: var(--ink); color: var(--bg); }
.wtab[aria-selected="true"] .wtab-name, .wtab[aria-selected="true"] .wtab-meta { color: var(--bg); }
.wtab[aria-selected="true"] .dots i { background: var(--ink2); }
.wtab[aria-selected="true"] .dots i.h { background: var(--accent); }
.wave { display: grid; gap: 14px; }
.wave-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
.wave-title h3 { font: 600 18px var(--display); margin: 0; }
.wave-title span { font: 12px var(--mono); color: var(--ink3); }
.after { flex-basis: 100%; margin: 0; font-size: 13.5px; color: var(--ink2); }
.after b { font-weight: 600; color: var(--up); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 14px; align-items: start; }
.grid > .child:last-child:nth-child(odd) { grid-column: 1 / -1; }
.child {
	background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
	padding: 16px 18px; display: grid; gap: 14px; scroll-margin-top: 16px; container-type: inline-size;
	transition: box-shadow .3s, border-color .3s;
}
.child.spine { border-color: var(--accent); }
.child:target, .child.lit { border-color: var(--ink); box-shadow: 0 0 0 3px var(--accent-soft); }
.child-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.child-key { font: 500 12px var(--mono); background: none; padding: 0; color: var(--accent); }
.child-head h3 { font: 600 16px/1.3 var(--display); margin: 0; flex: 1 1 22rem; min-width: 0; text-wrap: balance; }
.facts { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { font: 500 11px var(--mono); color: var(--ink2); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.pill.high { color: var(--accent); border-color: var(--accent); }
.child-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px 28px; }
@container (min-width: 720px) { .child-body { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); } }
.col { display: grid; gap: 8px; align-content: start; min-width: 0; }
h4 { font: 500 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink3); margin: 0; }
.quiet { color: var(--ink3); font-size: 13px; margin: 0; }
.needs { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.needs li { display: grid; gap: 4px; }
.needs p { margin: 0; font-size: 13.5px; color: var(--ink2); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { font: 500 11.5px var(--mono); text-decoration: none; color: var(--up); background: var(--up-soft); border-radius: 4px; padding: 0 6px; }
.chip:hover { text-decoration: underline; }
.many > summary { font: 500 12px var(--mono); color: var(--up); cursor: pointer; }
.many[open] > summary { margin-bottom: 4px; }
.scns { display: grid; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.scn { border-top: 1px solid var(--line); }
.scn:first-child { border-top: 0; }
.scn > summary, .scn.missing { list-style: none; display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; cursor: pointer; }
.scn.missing { cursor: default; color: var(--ink3); }
.scn > summary::-webkit-details-marker { display: none; }
.scn > summary::after { content: "+"; margin-left: auto; font: 500 14px var(--mono); color: var(--ink3); }
.scn[open] > summary::after { content: "−"; }
.scn > summary:hover { background: var(--sunk); }
.sid { font: 500 11.5px var(--mono); color: var(--accent); background: var(--accent-soft); border-radius: 4px; padding: 0 6px; flex: none; }
.scn-head { font-size: 13.5px; min-width: 0; }
.scn:not([open]) .scn-head { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.gwt { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; margin: 0; padding: 4px 12px 12px 12px; font-size: 13.5px; }
.gwt dt { font: 500 10.5px/2 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink3); }
.gwt dd { margin: 0; min-width: 0; }
.gwt ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.gwt-plain { margin: 0; padding: 4px 12px 12px; font-size: 13.5px; }
.loose { display: grid; gap: 12px; }
@media (prefers-reduced-motion: reduce) {
	*, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

const SCRIPT = `(() => {
const data = JSON.parse(document.getElementById("plan-data").textContent);
const map = document.querySelector(".map");
if (!map) return;
const layer = map.querySelector(".edges");
const nodes = new Map([...map.querySelectorAll(".node")].map((n) => [n.dataset.key, n]));
const edges = [...map.querySelectorAll(".edge")];
const ins = new Map(), outs = new Map();
const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
for (const e of edges) { push(outs, e.dataset.from, e.dataset.to); push(ins, e.dataset.to, e.dataset.from); }
const walk = (k, g, seen = new Set()) => { for (const x of g.get(k) || []) if (!seen.has(x)) { seen.add(x); walk(x, g, seen); } return seen; };
const tip = document.getElementById("tip");
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function show(k) {
	const up = walk(k, ins), down = walk(k, outs);
	map.classList.add("focus");
	for (const [key, n] of nodes) {
		n.classList.toggle("is-self", key === k);
		n.classList.toggle("is-up", up.has(key));
		n.classList.toggle("is-down", down.has(key));
	}
	for (const e of edges) {
		const a = e.dataset.from, b = e.dataset.to;
		const u = up.has(a) && (b === k || up.has(b));
		const d = down.has(b) && (a === k || down.has(a));
		e.classList.toggle("is-up", u);
		e.classList.toggle("is-down", d);
		if (u || d) layer.append(e);
	}
	const c = data.children[k];
	if (!c || !tip) return;
	tip.replaceChildren();
	const top = el("div", "tip-top");
	top.append(el("b", "", k), el("span", "", c.wave + (c.facts ? " · " + c.facts : "")));
	const rel = el("div", "tip-rel");
	const u = el("span", "u"); u.append(el("i"), document.createTextNode("Waits on " + up.size));
	const d = el("span", "d"); d.append(el("i"), document.createTextNode("Unblocks " + down.size));
	rel.append(u, d);
	tip.append(top, el("div", "tip-sum", c.summary), rel);
	if (c.why) tip.append(el("p", "tip-why", c.why));
	if (c.reqs.length) {
		const ids = el("div", "tip-ids");
		for (const r of c.reqs) ids.append(el("span", "", r));
		tip.append(ids);
	}
	const m = map.getBoundingClientRect(), r = nodes.get(k).getBoundingClientRect();
	const W = Math.min(280, m.width - 8), gap = 12;
	const left = r.left - m.left, nodeTop = r.top - m.top;
	tip.style.width = W + "px";
	tip.hidden = false;
	let x = left + r.width + gap, y = nodeTop - 4;
	if (x + W > m.width) x = left - W - gap;
	if (x < 0) { x = Math.max(4, Math.min(left, m.width - W - 4)); y = nodeTop + r.height + 8; }
	else y = Math.min(y, m.height - tip.offsetHeight - 4);
	tip.style.left = x + "px";
	tip.style.top = Math.max(4, y) + "px";
}
function clear() {
	map.classList.remove("focus");
	for (const n of nodes.values()) n.classList.remove("is-self", "is-up", "is-down");
	for (const e of edges) e.classList.remove("is-up", "is-down");
	if (tip) tip.hidden = true;
}
for (const [k, n] of nodes) {
	n.addEventListener("mouseenter", () => show(k));
	n.addEventListener("mouseleave", clear);
	n.addEventListener("focus", () => show(k));
	n.addEventListener("blur", clear);
}
const spineBtn = document.getElementById("spine-lines");
spineBtn?.addEventListener("click", () => {
	const on = spineBtn.getAttribute("aria-pressed") !== "true";
	spineBtn.setAttribute("aria-pressed", String(on));
	map.classList.toggle("no-spine", on);
});
const tabs = [...document.querySelectorAll(".wtab")];
const sections = [...document.querySelectorAll(".wave[data-wave]")];
let current = tabs[0]?.dataset.wave ?? "all", chosen = current;
function pick(w) {
	current = w;
	for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.wave === w));
	for (const s of sections) s.hidden = !(w === "all" || s.dataset.wave === w);
}
const waveOfKey = (k) => document.getElementById(k)?.closest(".wave")?.dataset.wave;
for (const t of tabs) t.addEventListener("click", () => { chosen = t.dataset.wave; pick(chosen); });
for (const col of map.querySelectorAll(".wave-col")) {
	const head = col.querySelector(".wave-head");
	const first = col.querySelector(".node");
	const w = first && waveOfKey(first.dataset.key);
	if (!head || !w) continue;
	head.style.cursor = "pointer";
	head.addEventListener("click", () => {
		chosen = w; pick(w);
		document.querySelector(".wave-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
	});
}
// A link to a child opens its wave first, so the browser can scroll to it.
document.addEventListener("click", (e) => {
	const a = e.target.closest && e.target.closest('a[href^="#"]');
	if (!a || current === "all") return;
	const w = waveOfKey(decodeURIComponent(a.hash.slice(1)));
	if (w && w !== current) { chosen = w; pick(w); }
}, true);
pick(waveOfKey(decodeURIComponent(location.hash.slice(1))) ?? current);
const cards = [...document.querySelectorAll(".child")];
const search = document.getElementById("plan-filter");
const found = document.getElementById("found");
search?.addEventListener("input", () => {
	const q = search.value.trim().toLowerCase();
	pick(q ? "all" : chosen);
	let shown = 0;
	for (const card of cards) {
		const hit = !q || card.dataset.text.includes(q);
		let any = false;
		for (const s of card.querySelectorAll(".scn")) {
			const sh = !q || s.dataset.text.includes(q);
			s.hidden = !(hit || sh);
			if (q && sh && !hit && s.tagName === "DETAILS") s.open = true;
			any ||= sh && !!q;
		}
		const show = hit || any;
		card.hidden = !show;
		if (show) shown++;
		nodes.get(card.dataset.key)?.classList.toggle("miss", !show);
	}
	for (const s of document.querySelectorAll('.wave[data-wave="loose"] .scn')) s.hidden = !!q && !s.dataset.text.includes(q);
	if (q) for (const w of sections) w.hidden = ![...w.querySelectorAll(".child, .scns > .scn")].some((c) => !c.hidden);
	if (found) found.textContent = q ? shown + " of " + cards.length + " children" : "";
});
const allBtn = document.getElementById("expand-all");
allBtn?.addEventListener("click", () => {
	const open = allBtn.getAttribute("aria-pressed") !== "true";
	allBtn.setAttribute("aria-pressed", String(open));
	allBtn.textContent = open ? "Collapse scenarios" : "Expand scenarios";
	for (const d of document.querySelectorAll("details.scn")) d.open = open;
});
})();`;

export function planPage(plan: ParentPlan, at: string): string {
	const waves = wavesOf(plan);
	const n = plan.children.length;
	const texts = new Map(plan.scenarios.map((s: Scenario) => [s.id, s.text]));
	const owned = new Set(plan.children.flatMap((c) => c.requirements));
	const loose = plan.scenarios.filter((s) => !owned.has(s.id));
	const high = plan.children.filter((c) => c.tier === "high").length;
	const sizes = ["S", "M", "L", "XL"]
		.map(
			(s) => [s, plan.children.filter((c) => sizeOf(c) === s).length] as const,
		)
		.filter(([, k]) => k > 0);
	const stats = [
		["Children", `${n}`],
		["Waves", `${waves.filter(([w]) => w > 0).length}<small>+ spine</small>`],
		["Scenarios", `${plan.scenarios.length}`],
		["High tier", `${high}`],
		...(sizes.length
			? [["Sizes", sizes.map(([s, k]) => `${k}<small>${s}</small>`).join(" ")]]
			: []),
	]
		.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
		.join("");
	const data = {
		children: Object.fromEntries(
			plan.children.map((c) => {
				const named = c.needs.filter(
					(x) => !plan.children.some((o) => o.key === x.key && o.wave === 0),
				);
				const why = (named[0] ?? c.needs[0])?.reason;
				return [
					c.key,
					{
						summary: c.summary,
						wave: waveName(c.wave),
						facts: [sizeOf(c), c.tier === "high" ? "high tier" : undefined]
							.filter(Boolean)
							.join(" · "),
						why,
						reqs: c.requirements,
					},
				];
			}),
		),
	};
	const edges = waitEdges(plan.children);
	const waveOf = new Map(plan.children.map((c) => [c.key, c.wave]));
	const after = (w: number, list: ChildPlan[]) => {
		if (w === 0) return "Lands first. Every other wave builds on it.";
		const from = [
			...new Set(
				list.flatMap((c) =>
					(edges.get(c.key) ?? []).map((k) => waveOf.get(k) ?? 0),
				),
			),
		].sort((a, b) => a - b);
		const names = from.map((f) => `<b>${waveName(f)}</b>`);
		const said =
			names.length > 1
				? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
				: (names[0] ?? `<b>${waveName(0)}</b>`);
		return `Starts once ${said} ${names.length > 1 ? "have" : "has"} landed.`;
	};
	const scCount = (list: ChildPlan[]) =>
		list.reduce((a, c) => a + c.requirements.length, 0);
	const tabs = [
		...waves.map(
			([w, list]) =>
				`<button type="button" role="tab" class="wtab${w === 0 ? " spine" : ""}" data-wave="${w}" aria-selected="${w === waves[0]?.[0]}"><span class="wtab-name">${waveName(w)}</span><span class="wtab-meta">${plural(list.length, "child", "children")} · ${plural(scCount(list), "scenario")}</span><span class="dots" aria-hidden="true">${list.map((c) => `<i${c.tier === "high" ? ' class="h"' : ""}></i>`).join("")}</span></button>`,
		),
		`<button type="button" role="tab" class="wtab" data-wave="all" aria-selected="false"><span class="wtab-name">All</span><span class="wtab-meta">${plural(n, "child", "children")} · ${plural(plan.scenarios.length, "scenario")}</span><span class="dots" aria-hidden="true"></span></button>`,
	].join("");
	const lists = waves
		.map(
			([w, list]) =>
				`<section class="wave" data-wave="${w}"><div class="wave-title"><h3>${waveName(w)}</h3><span>${plural(list.length, "child", "children")} · ${plural(scCount(list), "scenario")}</span><p class="after">${after(w, list)}</p></div><div class="grid">${list.map((c) => card(c, texts)).join("")}</div></section>`,
		)
		.join("");
	const looseBlock = loose.length
		? `<section class="wave" data-wave="loose"><div class="wave-title"><h3>Not yet owned</h3><span>${plural(loose.length, "scenario")} no child delivers</span></div><div class="scns">${loose.map((s) => scenarioRow(s.id, s.text)).join("")}</div></section>`
		: "";
	return `<title>${esc(plan.key)} wave plan</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${STYLE}</style>
<main>
<header class="top">
<p class="eyebrow">${esc(plan.key)} · wave plan</p>
<h1>${esc(plan.summary)}</h1>
<p class="meta">${plural(n, "child", "children")} in ${plural(waves.length, "wave")}, planned ${esc(at.slice(0, 10))}. This is the plan as the tickets hold it, without live progress.</p>
<dl class="stats">${stats}</dl>
</header>
<section class="sec" aria-label="Wave map">
<div class="sec-head"><h2>Waves</h2><div class="legend"><span><i class="sw spine"></i>Spine</span><span><i class="sw"></i>Child</span><span><b class="dia">◆</b>High tier</span><span><i class="ln up"></i>Waits on</span><span><i class="ln down"></i>Unblocks</span><button type="button" class="btn" id="spine-lines" aria-pressed="false">Hide spine lines</button></div></div>
<div class="drawing">${diagram(plan)}</div>
</section>
<section class="sec" aria-label="Children and scenarios">
<div class="sec-head"><h2>Children and scenarios<span class="n">${plural(plan.scenarios.length, "scenario")}</span></h2><div class="tools"><input class="search" id="plan-filter" type="search" placeholder="Filter by key, title or scenario" aria-label="Filter children and scenarios"><button type="button" class="btn" id="expand-all" aria-pressed="false">Expand scenarios</button><span class="found" id="found" aria-live="polite"></span></div></div>
<div class="wave-tabs" role="tablist" aria-label="Waves">${tabs}</div>
${lists}
${looseBlock}
</section>
</main>
<script type="application/json" id="plan-data">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>
<script>${SCRIPT}</script>
`;
}
