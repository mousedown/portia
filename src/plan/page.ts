import { waitEdges } from "../core/plan-edges";
import type { ChildPlan, ParentPlan } from "../core/types";

/**
 * The plan as a page to publish: the waves drawn as columns with each need as a line, then
 * every child with its needs and scenarios. It is the plan as the tickets hold it, so it
 * carries no progress, and like everything outward it never names the tool.
 */

const NODE_W = 112;
const NODE_H = 30;
const ROW_GAP = 10;
const COL_GAP = 72;
const HEAD = 34;
const PAD = 4;

const esc = (s: string) =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const waveName = (w: number) => (w === 0 ? "Spine" : `Wave ${w}`);

function wavesOf(plan: ParentPlan): [number, ChildPlan[]][] {
	const waves = [...new Set(plan.children.map((c) => c.wave))].sort(
		(a, b) => a - b,
	);
	return waves.map((w) => [w, plan.children.filter((c) => c.wave === w)]);
}

/** Columns to scale: one per wave, each child a node linking to its entry below. */
function diagram(plan: ParentPlan): string {
	const waves = wavesOf(plan);
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
	const edges: string[] = [];
	for (const [key, needs] of waitEdges(plan.children))
		for (const need of needs) {
			const a = at.get(need);
			const b = at.get(key);
			if (!a || !b) continue;
			const x1 = a.x + NODE_W;
			const y1 = a.y + NODE_H / 2;
			const x2 = b.x;
			const y2 = b.y + NODE_H / 2;
			const mid = (x1 + x2) / 2;
			edges.push(
				`<path class="edge" d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}"/>`,
			);
		}
	const heads = waves
		.map(
			([w, list], col) =>
				`<text class="head" x="${colX(col)}" y="16">${waveName(w)}</text><text class="count" x="${colX(col) + NODE_W}" y="16" text-anchor="end">${list.length}</text>`,
		)
		.join("");
	const nodes = plan.children
		.map((c) => {
			const p = at.get(c.key);
			if (!p) return "";
			return `<a href="#${esc(c.key)}"><title>${esc(c.summary)}</title><rect class="node${c.wave === 0 ? " spine" : ""}" x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="3"/><text class="key${c.wave === 0 ? " spine" : ""}" x="${p.x + NODE_W / 2}" y="${p.y + NODE_H / 2 + 4}" text-anchor="middle">${esc(c.key)}</text></a>`;
		})
		.join("");
	return `<svg role="img" aria-label="${esc(`${plan.key} waves, with each child's needs drawn as lines`)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${edges.join("")}${heads}${nodes}</svg>`;
}

function entry(c: ChildPlan): string {
	const facts = [
		c.size,
		c.tier === "high" ? "high tier" : undefined,
		`${c.touches.length} ${c.touches.length === 1 ? "path" : "paths"}`,
	].filter(Boolean);
	const scenarios = c.requirements.length
		? `<p class="scenarios">${c.requirements.map((r) => `<span>${esc(r)}</span>`).join("")}</p>`
		: "";
	const needs = c.needs.length
		? `<ul class="needs">${c.needs.map((n) => `<li><a href="#${esc(n.key)}">${esc(n.key)}</a> ${esc(n.reason)}</li>`).join("")}</ul>`
		: "";
	return `<li id="${esc(c.key)}" class="child"><div class="line"><code>${esc(c.key)}</code><span class="summary">${esc(c.summary)}</span><span class="facts">${esc(facts.join(" · "))}</span></div>${needs}${scenarios}</li>`;
}

const STYLE = `
/* A working drawing: the wave diagram leads, the entries below are its key. */
:root {
	--bg: #f5f6f8; --surface: #ffffff; --ink: #1b1e27; --ink2: #5a6072;
	--line: #cdd1db; --accent: #8a2f5e; --accent-soft: #f6e6ef;
	--sans: "IBM Plex Sans", system-ui, sans-serif;
	--mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
	:root:not([data-theme="light"]) {
		--bg: #12141b; --surface: #1b1e28; --ink: #e8e9ef; --ink2: #9aa0b2;
		--line: #363b4a; --accent: #e7a0c4; --accent-soft: #3a2230;
		color-scheme: dark;
	}
}
:root[data-theme="dark"] {
	--bg: #12141b; --surface: #1b1e28; --ink: #e8e9ef; --ink2: #9aa0b2;
	--line: #363b4a; --accent: #e7a0c4; --accent-soft: #3a2230;
	color-scheme: dark;
}
body {
	background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans);
	padding-left: max(16px, env(safe-area-inset-left, 0px));
	padding-right: max(16px, env(safe-area-inset-right, 0px));
	padding-block: 32px 56px;
}
main { max-width: 1000px; margin-inline: auto; display: grid; gap: 32px; }
main > * { min-width: 0; }
header { display: grid; gap: 4px; }
.eyebrow, h2 { font: 500 12px/1.4 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--ink2); margin: 0; }
h1 { font-size: 26px; line-height: 1.2; font-weight: 600; margin: 0; text-wrap: balance; }
.meta { color: var(--ink2); margin: 0; font-variant-numeric: tabular-nums; }
section { display: grid; gap: 12px; }
.drawing { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 16px; }
svg { display: block; }
.edge { fill: none; stroke: var(--ink2); stroke-opacity: .55; stroke-width: 1.25; }
.node { fill: var(--surface); stroke: var(--ink2); }
.node.spine { fill: var(--accent-soft); stroke: var(--accent); }
a:hover .node, a:focus-visible .node { stroke: var(--accent); stroke-width: 2; }
.head { fill: var(--ink); font: 600 13px var(--sans); }
.count { fill: var(--ink2); font: 12px var(--mono); }
.key { fill: var(--ink); font: 500 12px var(--mono); }
.key.spine { fill: var(--accent); }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; }
dt { font-family: var(--mono); color: var(--accent); }
dd { margin: 0; max-width: 70ch; }
ol { list-style: none; margin: 0; padding: 0; display: grid; }
.child { padding-block: 10px; border-top: 1px solid var(--line); display: grid; gap: 4px; scroll-margin-top: 12px; }
.child:target { background: var(--accent-soft); }
.line { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: baseline; }
.line code { font: 500 13px var(--mono); }
.summary { flex: 1 1 18rem; min-width: 0; }
.facts { color: var(--ink2); font-size: 13px; font-variant-numeric: tabular-nums; }
.needs { list-style: none; margin: 0; padding: 0; color: var(--ink2); font-size: 13px; }
.needs a { font-family: var(--mono); color: var(--accent); }
.scenarios { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; }
.scenarios span { font: 12px var(--mono); color: var(--accent); background: var(--accent-soft); padding: 0 6px; border-radius: 3px; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

export function planPage(plan: ParentPlan, at: string): string {
	const waves = wavesOf(plan);
	const n = plan.children.length;
	const scenarios = plan.scenarios.length
		? `<section><h2>Scenarios</h2><dl>${plan.scenarios.map((s) => `<dt>${esc(s.id)}</dt><dd>${esc(s.text)}</dd>`).join("")}</dl></section>`
		: "";
	const lists = waves
		.map(
			([w, list]) =>
				`<section><h2>${waveName(w)}</h2><ol>${list.map(entry).join("")}</ol></section>`,
		)
		.join("");
	return `<title>${esc(plan.key)} wave plan</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>${STYLE}</style>
<main>
<header>
<p class="eyebrow">${esc(plan.key)}</p>
<h1>${esc(plan.summary)}</h1>
<p class="meta">${n} ${n === 1 ? "child" : "children"} in ${waves.length} ${waves.length === 1 ? "wave" : "waves"} · planned ${esc(at.slice(0, 10))}. This is the plan as the tickets hold it, without live progress.</p>
</header>
<section><h2>Waves</h2><div class="drawing">${diagram(plan)}</div></section>
${scenarios}
${lists}
</main>
`;
}
