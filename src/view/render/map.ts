import type { ChildView, Role, RunView } from "../model/types";
import type { Ctx } from "./common";
import { childGlyph, STATE_ROLE } from "./common";
import type { Line, Span } from "./text";
import { sp, strWidth } from "./text";

/**
 * The Run page's map: the run's shape at a glance. Waves are columns, children are
 * nodes, and each need is drawn as a line from the child waited on to the child that
 * waits, `✓ 501 ──▶ ! 502 ──┬──▶ · 503`. A child of a later wave that names no need
 * waits on the spine, so its line comes from there.
 */

/** Cells between two columns: room for a branch, a merge and `▶ `. */
const GAP = 7;
/** Rows of nodes the map draws at most; a taller run keeps only its list. */
export const MAP_MAX_ROWS = 8;

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;
const BOX: Record<number, string> = {
	[LEFT | RIGHT]: "─",
	[UP | DOWN]: "│",
	[DOWN | RIGHT]: "┌",
	[DOWN | LEFT]: "┐",
	[UP | RIGHT]: "└",
	[UP | LEFT]: "┘",
	[LEFT | RIGHT | DOWN]: "┬",
	[LEFT | RIGHT | UP]: "┴",
	[UP | DOWN | RIGHT]: "├",
	[UP | DOWN | LEFT]: "┤",
	[UP | DOWN | LEFT | RIGHT]: "┼",
	[LEFT]: "─",
	[RIGHT]: "─",
	[UP]: "│",
	[DOWN]: "│",
};
const ASCII: Record<string, string> = {
	"─": "-",
	"│": "|",
	"▶": ">",
};

/** A line's colour: the state of the child it leads into, so the map shows how far the run has got. */
function lineRole(c: ChildView): Role {
	if (c.state === "landed" || c.state === "closed" || c.state === "done")
		return "landed";
	if (c.state === "running" || c.state === "ready") return "running";
	if (c.state === "parked") return "parked";
	if (c.state === "failed") return "failed";
	return "faint";
}

/** Where two lines share a cell, the one that needs attention shows. */
const RANK: Partial<Record<Role, number>> = {
	faint: 1,
	landed: 2,
	running: 3,
	parked: 4,
	failed: 5,
};
const rank = (r?: Role) => (r ? (RANK[r] ?? 0) : 0);

/** The key without the prefix every child shares: `ACME-505` is `505` when all are `ACME-`. */
export function shortKeys(keys: string[]): (k: string) => string {
	const pre = /^[^-]+-/.exec(keys[0] ?? "")?.[0];
	if (!pre || keys.some((k) => !k.startsWith(pre))) return (k) => k;
	return (k) => k.slice(pre.length);
}

interface Node {
	c: ChildView;
	row: number;
	col: number;
}

/** Which children each child waits on, inside this run: its needs, else the spine. */
function edgesOf(r: RunView): Map<string, string[]> {
	const inRun = new Set(r.children.map((c) => c.key));
	const spine = r.children.filter((c) => c.wave === 0).map((c) => c.key);
	const out = new Map<string, string[]>();
	for (const c of r.children) {
		const named = (c.needs ?? [])
			.map((n) => n.key)
			.filter((k) => inRun.has(k) && k !== c.key);
		out.set(c.key, named.length || c.wave === 0 ? named : spine);
	}
	// A need another need already waits on adds no line: 503 needing the spine and
	// 502, which needs the spine too, draws only 502 ──▶ 503.
	const reach = (from: string, seen = new Set<string>()): Set<string> => {
		for (const k of out.get(from) ?? [])
			if (!seen.has(k)) {
				seen.add(k);
				reach(k, seen);
			}
		return seen;
	};
	for (const [key, needs] of out)
		out.set(
			key,
			needs.filter((k) => !needs.some((o) => o !== k && reach(o).has(k))),
		);
	return out;
}

/**
 * Rows: a child carries on the row of the first child it waits on while that row ends
 * there, so a chain reads along one line; otherwise it starts a row of its own.
 */
function place(r: RunView, edges: Map<string, string[]>): Map<string, Node> {
	const waves = [...new Set(r.children.map((c) => c.wave))].sort(
		(a, b) => a - b,
	);
	const col = new Map(waves.map((w, i) => [w, i]));
	const nodes = new Map<string, Node>();
	/** The key that ends each row so far, by row id. */
	const ends: string[] = [];
	/** Row ids top to bottom. A branch's row goes under its source's, after the rows
	 * its earlier branches took, so a fan-out sits together and no line crosses another. */
	const order: number[] = [];
	/** The last row each source's branches took. */
	const below = new Map<string, number>();
	for (const w of waves)
		for (const c of r.children.filter((x) => x.wave === w)) {
			const needs = (edges.get(c.key) ?? [])
				.map((k) => nodes.get(k))
				.filter((n): n is Node => !!n);
			const from = needs.find((n) => ends[n.row] === n.c.key);
			let row: number;
			if (from) row = from.row;
			else {
				row = ends.length;
				const src = needs[0];
				if (src) {
					// Straight under the source's own row, ahead of rows that branched from
					// earlier columns, whose lines then pass to the left of this one.
					const after = below.get(src.c.key) ?? src.row;
					order.splice(order.indexOf(after) + 1, 0, row);
					below.set(src.c.key, row);
				} else order.push(row);
			}
			ends[row] = c.key;
			nodes.set(c.key, { c, row, col: col.get(w) ?? 0 });
		}
	// Rows by where they sit, top to bottom.
	for (const n of nodes.values()) n.row = order.indexOf(n.row);
	return nodes;
}

/**
 * The map in lines, or none when it does not fit `w` cells and `MAP_MAX_ROWS` rows,
 * or when the run has a single wave and so no shape to show.
 */
export function runMap(ctx: Ctx, r: RunView, w: number): Line[] {
	const waves = new Set(r.children.map((c) => c.wave));
	if (waves.size < 2) return [];
	const edges = edgesOf(r);
	const nodes = place(r, edges);
	const rows = Math.max(...[...nodes.values()].map((n) => n.row)) + 1;
	if (rows > MAP_MAX_ROWS) return [];
	const short = shortKeys(r.children.map((c) => c.key));
	const KW = Math.max(...r.children.map((c) => strWidth(short(c.key))));
	// A node is its glyph, a space and its key.
	const NW = 2 + KW;
	const colW = NW + GAP;
	const cols = waves.size;
	const width = cols * colW - GAP;
	if (width > w) return [];

	const bits: number[][] = Array.from({ length: rows }, () =>
		Array<number>(width).fill(0),
	);
	/** Each cell's colour: the state of the child its line leads into, the busiest winning. */
	const tone: (Role | undefined)[][] = Array.from({ length: rows }, () =>
		Array<Role | undefined>(width).fill(undefined),
	);
	const arrows = new Map<string, Role>();
	let ink: Role = "faint";
	const set = (y: number, x: number, b: number) => {
		const line = bits[y];
		if (!line || x < 0 || x >= width) return;
		line[x] = (line[x] ?? 0) | b;
		const t = tone[y];
		if (t && rank(ink) > rank(t[x])) t[x] = ink;
	};
	const hline = (y: number, from: number, to: number) => {
		for (let x = from; x <= to; x++)
			set(y, x, (x > from ? LEFT : 0) | (x < to ? RIGHT : 0));
	};
	const vline = (x: number, from: number, to: number) => {
		const [a, b] = from < to ? [from, to] : [to, from];
		for (let y = a; y <= b; y++)
			set(y, x, (y > a ? UP : 0) | (y < b ? DOWN : 0));
	};
	const xOf = (n: Node) => n.col * colW;
	for (const n of nodes.values())
		for (const k of edges.get(n.c.key) ?? []) {
			const s = nodes.get(k);
			if (!s) continue;
			const start = xOf(s) + NW + 1;
			const tip = xOf(n) - 2;
			ink = lineRole(n.c);
			arrows.set(`${n.row}:${tip}`, ink);
			if (s.row === n.row) {
				hline(n.row, start, tip - 1);
				continue;
			}
			// Down: branch just after the source. Up: merge just before the target.
			const vx = n.row > s.row ? start + 1 : tip - 2;
			hline(s.row, start, vx);
			vline(vx, s.row, n.row);
			hline(n.row, vx, tip - 1);
			// The corners join the line they turn into.
			set(s.row, vx, LEFT);
			set(n.row, vx, RIGHT);
		}

	const sel = ctx.state.childKey;
	const head: Line = [sp(1)];
	const labels = [...waves].sort((a, b) => a - b);
	labels.forEach((wv, i) => {
		const label = wv === 0 ? "spine" : `wave ${wv}`;
		const at = i * colW;
		const used = head.reduce((s, x) => s + strWidth(x.text), 0) - 1;
		if (at > used) head.push(sp(at - used));
		head.push({ text: label, role: "dim" });
	});

	const lines: Line[] = [head];
	for (let y = 0; y < rows; y++) {
		const out: Span[] = [sp(1)];
		const here = [...nodes.values()].filter((n) => n.row === y);
		let x = 0;
		let buf = "";
		let bufRole: Role = "faint";
		const flush = () => {
			if (buf) out.push({ text: buf, role: bufRole });
			buf = "";
		};
		while (x < width) {
			const n = here.find((m) => xOf(m) === x);
			if (n) {
				flush();
				const key = short(n.c.key);
				out.push(childGlyph(ctx, n.c), sp(1), {
					text: key.padEnd(KW),
					role: STATE_ROLE[n.c.state],
					bold: n.c.key === sel,
					underline: n.c.key === sel,
				});
				x += NW;
				continue;
			}
			const arrow = arrows.get(`${y}:${x}`);
			if (arrow) {
				flush();
				out.push({ text: ctx.ink.unicode ? "▶" : ">", role: arrow });
				x++;
				continue;
			}
			const b = bits[y]?.[x] ?? 0;
			const role = tone[y]?.[x] ?? "faint";
			if (role !== bufRole) {
				flush();
				bufRole = role;
			}
			const ch = b ? (BOX[b] ?? "┼") : " ";
			buf += ctx.ink.unicode ? ch : (ASCII[ch] ?? (b ? "+" : " "));
			x++;
		}
		flush();
		lines.push(out);
	}
	return lines;
}
