import { basename, dirname } from "node:path";
import { hhmm } from "../model/format";
import {
	diskLevel,
	type Level,
	type MachineView,
	memFloorMb,
	pair,
	pct,
	pressureOf,
	size,
	THRESHOLDS,
	uptimeText,
} from "../model/machine";
import type { Role } from "../model/types";
import type { Ctx } from "./common";
import { plainLabel, shortPath, tilde } from "./common";
import {
	cell,
	type Line,
	lineWidth,
	lr,
	pad,
	rcell,
	type Span,
	sp,
	strWidth,
	truncate,
} from "./text";

/** A figure past its threshold: amber when it warns, rose when it is critical. */
export const levelRole = (l: Level, base: Role = "ink2"): Role =>
	l === "critical" ? "failed" : l === "warn" ? "warn" : base;

/** A figure's text, with ▲ (ASCII `!`) before it past a threshold, so it shows without colour. */
export const flagged = (ctx: Ctx, text: string, l: Level) =>
	l === "ok" ? text : `${ctx.g.alert}${text}`;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * `━━━━━━╸─────`: a thin rule `w` cells wide, the share filled in its role on a faint
 * track, with a half cell at the edge. In ASCII it is `=` on `-`.
 */
export function meter(ctx: Ctx, frac: number, w: number, role: Role): Span[] {
	if (w <= 0) return [];
	const f = clamp01(frac) * w;
	let full = Math.floor(f);
	let half = ctx.g.meter.half && f - full >= 0.5 ? 1 : 0;
	if (full >= w) {
		full = w;
		half = 0;
	}
	return [
		{ text: ctx.g.bar.repeat(full) + (half ? ctx.g.meter.half : ""), role },
		{ text: ctx.g.rule.repeat(w - full - half), role: "faint" as Role },
	].filter((s) => s.text);
}

/** A bar with no ends and no track: a size against the largest, not a share of a capacity. */
export function bar(ctx: Ctx, frac: number, w: number, role: Role): Span[] {
	const g = ctx.g.meter;
	const f = clamp01(frac) * w;
	const full = Math.min(w, Math.floor(f));
	const part = full < w ? (g.parts[Math.floor((f - full) * 8)] ?? "") : "";
	const text = g.full.repeat(full) + part;
	const rest = w - strWidth(text);
	return rest > 0 ? [{ text, role }, sp(rest)] : [{ text, role }];
}

/**
 * The values (0–1, oldest first) in w cells, newest at the right: each cell is the mean
 * of its share of the window. A cell with no reading is a space here.
 */
export function sparkText(
	levels: string[],
	values: (number | null)[],
	w: number,
): string {
	if (w <= 0) return "";
	const n = values.length;
	const cells: string[] = [];
	const per = Math.max(1, n / w);
	const used = Math.min(w, Math.ceil(n / per));
	for (let i = 0; i < used; i++) {
		const from = Math.floor(n - (used - i) * per);
		const to = Math.floor(n - (used - i - 1) * per);
		const xs = values
			.slice(Math.max(0, from), Math.max(0, to))
			.filter((v): v is number => typeof v === "number");
		if (!xs.length) {
			cells.push(" ");
			continue;
		}
		const v = clamp01(xs.reduce((s, x) => s + x, 0) / xs.length);
		cells.push(
			levels[
				Math.min(levels.length - 1, Math.round(v * (levels.length - 1)))
			] ?? " ",
		);
	}
	return " ".repeat(w - used) + cells.join("");
}

/** Cells of a w-cell sparkline from its first reading to the right edge. */
export function sparkUsed(values: (number | null)[], w: number): number {
	const first = values.findIndex((v) => typeof v === "number");
	if (first < 0 || w <= 0) return 0;
	const per = Math.max(1, values.length / w);
	return Math.min(w, Math.ceil((values.length - first) / per));
}

/** A sparkline; a cell with no reading is a faint `·`, never the lowest level, which reads as 0%. */
export function spark(
	ctx: Ctx,
	values: (number | null)[],
	w: number,
	role: Role = "ink2",
): Span[] {
	const text = sparkText(ctx.g.spark, values, w);
	const out: Span[] = [];
	for (const ch of text) {
		const none = ch === " ";
		const r: Role = none ? "faint" : role;
		const c = none ? ctx.g.nodata : ch;
		const last = out.at(-1);
		if (last && last.role === r) last.text += c;
		else out.push({ text: c, role: r });
	}
	return out;
}

const gb = (mb: number) => mb / 1024;
/** The filesystem the header shows: the one with the least room. */
const tightest = (m: MachineView) =>
	[...m.disks].sort(
		(a, b) => a.freeMb / (a.totalMb || 1) - b.freeMb / (b.totalMb || 1),
	)[0];

/** The label column of Home's status grid, census and machine alike: `children` and a gap. */
export const GRID_LABEL = 9;

/** How much each line of the header block says. */
type Detail = "full" | "medium" | "short" | "none";
interface Form {
	/** 2: host, OS and uptime; 1: host and uptime; 0: no host line. */
	host: 0 | 1 | 2;
	/** Cells of each gauge. */
	g: number;
	detail: Detail;
	/** Cells of the label column: 9 lines up with the census beside the hero. */
	lab: number;
}
/** Widest first; each drops what matters least. */
const FORMS: Form[] = [
	{ host: 2, g: 12, detail: "full", lab: GRID_LABEL },
	{ host: 1, g: 12, detail: "medium", lab: GRID_LABEL },
	{ host: 1, g: 8, detail: "medium", lab: GRID_LABEL },
	{ host: 0, g: 8, detail: "medium", lab: 7 },
	{ host: 0, g: 0, detail: "medium", lab: 7 },
	{ host: 0, g: 8, detail: "short", lab: 5 },
	{ host: 0, g: 6, detail: "short", lab: 5 },
	{ host: 0, g: 0, detail: "short", lab: 5 },
	{ host: 0, g: 0, detail: "none", lab: 5 },
];

/**
 * The widest the block's figures get on this machine: a full CPU, a load of 99.9,
 * every byte of memory used, 99.9 GB of swap and of free disk, every slot taken.
 * Totals, cores and the cap stay as they are: they do not move between samples.
 */
function worstCase(m: MachineView): MachineView {
	const disk = tightest(m);
	return {
		...m,
		cpu: 1,
		load: [99.9, 99.9, 99.9],
		mem: { ...m.mem, usedMb: m.mem.totalMb, availableMb: 0 },
		...(m.swap ? { swap: { ...m.swap, usedMb: 99.9 * 1024 } } : {}),
		disks: disk ? [{ ...disk, freeMb: 99.9 * 1024 }] : [],
		...(m.slots ? { slots: { ...m.slots, used: m.slots.cap, free: 0 } } : {}),
	};
}

/**
 * The block's lines in one form, on one grid: the label in `lab` cells, the gauge in
 * `g`, the share right-aligned in 5 (room for ▲100%), then the detail. Every gauge is
 * the same thin rule, so the three read down as one column.
 */
function blockLines(ctx: Ctx, m: MachineView, f: Form): Line[] {
	const p = pressureOf(m);
	const disk = tightest(m);
	const memShare = m.mem.usedMb / Math.max(1, m.mem.totalMb);
	const long = f.lab >= 7;
	const lab = (t: string): Span => ({ text: t.padEnd(f.lab), role: "dim" });
	const share = (text: string, l: Level, quiet = false): Span[] =>
		rcell(flagged(ctx, text, l), 5, quiet ? "dim" : levelRole(l));
	const detail = (spans: Span[]): Span[] =>
		f.detail === "none" || !spans.length ? [] : [sp(long ? 2 : 1), ...spans];
	const gauge = (frac: number, role: Role): Span[] =>
		f.g ? [...meter(ctx, frac, f.g, role), sp(1)] : [];

	const loadText = (t: string): Span[] => [
		{ text: "load ", role: "dim" },
		{ text: m.load[0].toFixed(1), role: levelRole(p.load) },
		{ text: t, role: "dim" },
	];
	const cpu: Line = [
		lab("cpu"),
		...gauge(m.cpu ?? 0, levelRole(p.load)),
		...share(pct(m.cpu), p.load, typeof m.cpu !== "number"),
		...detail(
			f.detail === "full"
				? loadText(` of ${m.cores} cores${m.cgroup?.cpu ? " (cgroup)" : ""}`)
				: f.detail === "medium"
					? loadText(`/${m.cores}c`)
					: [],
		),
	];

	const memFig =
		f.detail === "short"
			? `${Math.round(gb(m.mem.usedMb))}/${Math.round(gb(m.mem.totalMb))}G`
			: `${pair(m.mem.usedMb, m.mem.totalMb)}${m.cgroup?.mem ? " (cgroup)" : ""}`;
	const mem: Line = [
		lab(long ? "memory" : "mem"),
		...gauge(memShare, levelRole(p.mem)),
		...share(pct(memShare), p.mem),
		...detail([
			{ text: memFig, role: levelRole(p.mem) },
			...(f.detail === "full" && m.swap
				? [
						{ text: " · swap ", role: "dim" as Role },
						{ text: size(m.swap.usedMb), role: "ink2" as Role },
					]
				: []),
		]),
	];

	const slots: Span[] =
		m.slots && (f.detail === "full" || f.detail === "medium")
			? [
					{ text: " · slots ", role: "dim" },
					{
						text: `${m.slots.used}/${m.slots.used + m.slots.free}`,
						role: m.slots.free ? "ink2" : "warn",
					},
				]
			: [];
	let diskLine: Line = [];
	if (disk) {
		const level = diskLevel(disk.freeMb, disk.totalMb);
		const used = 1 - disk.freeMb / Math.max(1, disk.totalMb);
		const role: Role = disk.stale ? "dim" : levelRole(level);
		diskLine = [
			lab("disk"),
			...gauge(used, role),
			...share(pct(used), level, disk.stale),
			...detail([
				{ text: size(disk.freeMb, f.detail !== "full"), role },
				{ text: " free", role: "dim" },
				...slots,
			]),
		];
	} else if (slots.length)
		diskLine = [
			lab("disk"),
			...(f.g ? [sp(f.g + 1)] : []),
			...share("—", "ok", true),
			...detail(slots.slice(1)),
		];

	const up = uptimeText(m.uptimeS);
	const host: Line[] =
		f.host === 2
			? [[lab("host"), { text: `${m.host} · ${m.os} · up ${up}`, role: "dim" }]]
			: f.host === 1
				? [[lab("host"), { text: `${m.host} · up ${up}`, role: "dim" }]]
				: [];
	return [...host, cpu, mem, diskLine].filter((l) => l.length);
}

/**
 * The machine block beside the hero, in `room` cells. Its width comes from the
 * widest its figures can get, never from what they read now, so its left edge stays
 * put from one sample to the next, and every line is padded to it. Forms step down
 * together, dropping what matters least first: the OS and the swap, then the long
 * units and the graphics' width, the host line, and last everything but the shares.
 */
export function machineBlock(ctx: Ctx, room: number, graphics = false): Line[] {
	const m = ctx.models.machine;
	if (!m) return [];
	const worst = worstCase(m);
	for (const f of FORMS) {
		if (graphics && !f.g) continue;
		const w = Math.max(0, ...blockLines(ctx, worst, f).map(lineWidth));
		if (w > room) continue;
		return blockLines(ctx, m, f).map((l) => pad(l, w));
	}
	return [];
}

/** The strip's forms, widest first: no host line, the graphics kept as long as they fit. */
const STRIP_FORMS: Form[] = [
	{ host: 0, g: 12, detail: "medium", lab: 5 },
	{ host: 0, g: 8, detail: "medium", lab: 5 },
	{ host: 0, g: 8, detail: "short", lab: 5 },
	{ host: 0, g: 6, detail: "none", lab: 5 },
	{ host: 0, g: 4, detail: "none", lab: 5 },
];
const STRIP_GAP = 3;

/**
 * The machine block as one line, for a header with no room for the hero. Each part is
 * padded to the widest its figures get, so nothing shifts between samples; empty when
 * even the smallest form with graphics does not fit `room`.
 */
export function machineStrip(ctx: Ctx, room: number): Line {
	const m = ctx.models.machine;
	if (!m) return [];
	const worst = worstCase(m);
	for (const f of STRIP_FORMS) {
		const widths = blockLines(ctx, worst, f).map(lineWidth);
		const total =
			widths.reduce((a, b) => a + b, 0) + STRIP_GAP * (widths.length - 1);
		if (total > room) continue;
		const out: Line = [];
		blockLines(ctx, m, f).forEach((l, i) => {
			if (i) out.push(sp(STRIP_GAP));
			out.push(...pad(l, widths[i] ?? lineWidth(l)));
		});
		return out;
	}
	return [];
}

/** The compact header's tail: `cpu 37% · mem 64% · disk 312G free`, as separate parts. */
export function machineTail(ctx: Ctx): Line[] {
	const m = ctx.models.machine;
	if (!m) return [];
	const p = pressureOf(m);
	const disk = tightest(m);
	const out: Line[] = [
		[
			{ text: "mem ", role: "dim" },
			{
				text: flagged(
					ctx,
					pct(m.mem.usedMb / Math.max(1, m.mem.totalMb)),
					p.mem,
				),
				role: levelRole(p.mem, "dim"),
			},
		],
		[
			{ text: "cpu ", role: "dim" },
			{
				text: flagged(ctx, pct(m.cpu), p.load),
				role: levelRole(p.load, "dim"),
			},
		],
	];
	if (disk) {
		const level = diskLevel(disk.freeMb, disk.totalMb);
		out.push([
			{ text: "disk ", role: "dim" },
			{
				text: flagged(ctx, size(disk.freeMb, true), level),
				role: disk.stale ? "dim" : levelRole(level, "dim"),
			},
			{ text: " free", role: "dim" },
		]);
	}
	// Most important first: memory, CPU, disk.
	return out;
}

/**
 * The Machine page's note under its header, in `room` cells: host, OS, uptime and cores,
 * or the host and the uptime, the host cut first and the uptime never.
 */
export function machineNote(
	m: MachineView,
	room: number,
	unicode = true,
): Line {
	const up = `up ${uptimeText(m.uptimeS)}`;
	const full = `${m.host} · ${m.os} · ${up} · ${m.cores} cores`;
	if (strWidth(full) <= room) return [{ text: full, role: "dim" }];
	const tail = ` · ${up}`;
	const hostRoom = room - strWidth(tail);
	if (hostRoom < 4)
		return strWidth(up) <= room ? [{ text: up, role: "dim" }] : [];
	const host =
		strWidth(m.host) <= hostRoom
			? m.host
			: `${[...m.host].slice(0, hostRoom - 1).join("")}${unicode ? "…" : "~"}`;
	return [{ text: `${host}${tail}`, role: "dim" }];
}

function head(
	text: string,
	right: Span[] | string,
	w: number,
	role: Role = "dim",
): Line {
	const r: Span[] =
		typeof right === "string" ? (right ? [{ text: right, role }] : []) : right;
	return lr([{ text: plainLabel(text), role: "ink2", bold: true }], r, w);
}

const ago = (ms: number) =>
	ms < 60_000
		? `${Math.max(1, Math.round(ms / 1000))}s ago`
		: `${Math.round(ms / 60_000)} min ago`;

/** Under a sparkline: how long ago its first reading was, at that reading's cell, and now. */
function axis(values: (number | null)[], stepMs: number, w: number): Line {
	const used = sparkUsed(values, w);
	if (!used) return [{ text: "no readings yet", role: "faint" }];
	const first = values.findIndex((v) => typeof v === "number");
	const label = ago((values.length - first) * stepMs);
	const at = Math.max(0, Math.min(w - used, w - strWidth(label) - 5));
	return lr(
		[sp(at), { text: label, role: "faint" }],
		[{ text: "now", role: "faint" }],
		w,
	);
}

/** The first of these that fits whole, or nothing: a part is never cut mid-word. */
function fitParts(parts: Span[][], room: number): Span[] {
	for (const p of parts) if (lineWidth(p) <= room) return p;
	return [];
}

function cpuSection(ctx: Ctx, m: MachineView, w: number): Line[] {
	const p = pressureOf(m);
	const per = m.perCore ?? [];
	const busiest = per.length ? Math.max(...per) : undefined;
	// One cell per core, spaced while they fit; past that, the cores share cells.
	const room = w - 7 - 14;
	const spaced = per.length * 2 - 1 <= room;
	const coreText = spaced
		? per.map((v) => sparkText(ctx.g.spark, [v], 1)).join(" ")
		: sparkText(ctx.g.spark, per, Math.min(per.length, room));
	const loadFigs: Span[] = [
		{ text: "load   ", role: "dim" },
		{
			text: flagged(ctx, m.load[0].toFixed(1), p.load),
			role: levelRole(p.load, "ink"),
		},
		{ text: "  ", role: "dim" },
		{ text: m.load[1].toFixed(1), role: "ink2" },
		{ text: "  ", role: "dim" },
		{ text: m.load[2].toFixed(1), role: "ink2" },
	];
	const cores = `${m.cores} ${m.cgroup?.cpu ? "cgroup " : ""}cores`;
	const suffix = fitParts(
		[
			[{ text: `   1 · 5 · 15 min, of ${cores}`, role: "dim" }],
			[{ text: `   of ${cores}`, role: "dim" }],
		],
		w - lineWidth(loadFigs),
	);
	const waits = [
		...(m.iowait !== undefined && m.iowait >= 0.01
			? [`iowait ${pct(m.iowait)}`]
			: []),
		...(m.steal !== undefined && m.steal >= 0.01
			? [`steal ${pct(m.steal)}`]
			: []),
	];
	return [
		head(
			"CPU",
			[
				{
					text: flagged(ctx, pct(m.cpu), p.load),
					role: typeof m.cpu !== "number" ? "dim" : levelRole(p.load, "ink"),
				},
				...(m.cgroup?.cpu ? [{ text: " (cgroup)", role: "dim" as Role }] : []),
			],
			w,
		),
		spark(ctx, m.history.cpu, w),
		axis(m.history.cpu, m.history.stepMs, w),
		[
			{ text: "cores  ", role: "dim" },
			...(per.length
				? [
						{ text: coreText, role: "ink2" as Role },
						{ text: "  busiest ", role: "dim" as Role },
						{ text: pct(busiest), role: "ink2" as Role },
					]
				: [
						{
							text: m.cgroup?.cpu
								? `${m.cores} by the cgroup's quota`
								: `${m.cores} · sampling`,
							role: "dim" as Role,
						},
					]),
		],
		[...loadFigs, ...suffix],
		...(waits.length
			? [
					[
						{ text: "wait   ", role: "dim" as Role },
						{ text: waits.join(" · "), role: "ink2" as Role },
					],
				]
			: []),
	];
}

/**
 * Memory over the window, scaled to its own range so a move from 52% to 64% shows,
 * with the range beside it: on a 0–100% scale that move is a flat line.
 */
function trend(ctx: Ctx, values: number[], w: number): Line {
	const label: Span = { text: "trend  ", role: "dim" };
	if (!values.length) return [label, { text: "sampling", role: "dim" }];
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	const [a, b] = [Math.floor(lo * 100), Math.ceil(hi * 100)];
	const range = a === b ? `${a}%` : `${a}–${b}%`;
	const from = lo - 0.02;
	const span = hi + 0.02 - from;
	const scaled = values.map((v) => clamp01((v - from) / span));
	const sw = Math.max(1, w - 7 - strWidth(range) - 2);
	return [
		label,
		...spark(ctx, scaled, sw, "dim"),
		sp(2),
		{ text: range, role: "dim" },
	];
}

function memSection(ctx: Ctx, m: MachineView, w: number): Line[] {
	const p = pressureOf(m);
	const role = levelRole(p.mem);
	const share = m.mem.usedMb / Math.max(1, m.mem.totalMb);
	// The label and the percentage take 12 cells; the gauge has the rest.
	const barW = Math.max(8, w - 7 - 5);
	const floor = memFloorMb(m.mem.totalMb, m.minFreeMb);
	const lines: Line[] = [
		head(
			"MEMORY",
			`${pair(m.mem.usedMb, m.mem.totalMb)} used${m.cgroup?.mem ? " (cgroup)" : ""}`,
			w,
			"ink",
		),
		[
			{ text: "used   ", role: "dim" },
			...meter(ctx, share, barW, role),
			...rcell(flagged(ctx, pct(share), p.mem), 5, role),
		],
		[
			{ text: "avail  ", role: "dim" },
			{
				text: flagged(ctx, size(m.mem.availableMb), p.mem),
				role: levelRole(p.mem, "ink2"),
			},
			{
				text: ` · floor ${size(floor)} ${m.minFreeMb !== undefined ? "(profile)" : `(${Math.round(THRESHOLDS.memFloorShare * 100)}%)`}`,
				role: "dim",
			},
		],
	];
	if (m.swap) {
		const s = m.swap.usedMb / Math.max(1, m.swap.totalMb);
		lines.push([
			{ text: "swap   ", role: "dim" },
			...meter(ctx, s, barW, "ink2"),
			...rcell(pct(s), 5, "ink2"),
		]);
	}
	lines.push(trend(ctx, m.history.mem, w));
	return lines;
}

function diskSection(ctx: Ctx, m: MachineView, w: number): Line[] {
	const t = tightest(m);
	if (!t)
		return [head("DISK", "", w), [{ text: "not available here", role: "dim" }]];
	const tLevel = diskLevel(t.freeMb, t.totalMb);
	const lines: Line[] = [
		head(
			"DISK",
			[
				{
					text: flagged(ctx, `${size(t.freeMb)} free`, tLevel),
					role: t.stale ? "dim" : levelRole(tLevel, "ink"),
				},
			],
			w,
		),
	];
	// The label and the percentage take 12 cells; the gauge has the rest.
	const barW = Math.max(8, w - 7 - 5);
	// One filesystem holding the home and the worktrees needs no name line.
	const named =
		m.disks.length > 1 || m.disks[0]?.labels.join(" · ") !== "home · worktrees";
	for (const d of m.disks) {
		const level = diskLevel(d.freeMb, d.totalMb);
		const used = 1 - d.freeMb / Math.max(1, d.totalMb);
		const role: Role = d.stale ? "dim" : levelRole(level);
		if (named) {
			// The labels say what lives there; the path gives way to them.
			const name = d.labels.join(" · ");
			const room = w - strWidth(name) - 2;
			lines.push(
				lr(
					[{ text: name, role: "ink" }],
					room >= 8
						? [
								{
									text: shortPath(tilde(d.path), room, ctx.ink.unicode),
									role: "dim",
								},
							]
						: [],
					w,
				),
			);
		}
		lines.push(
			[
				{ text: "used   ", role: "dim" },
				...meter(ctx, used, barW, role),
				...rcell(flagged(ctx, pct(used), level), 5, role),
			],
			[
				{ text: "free   ", role: "dim" },
				{
					text: size(d.freeMb),
					role: d.stale ? "dim" : levelRole(level, "ink"),
				},
				{ text: ` of ${size(d.totalMb)}`, role: "dim" },
				...(d.stale ? [{ text: " · not answering", role: "dim" as Role }] : []),
			],
		);
	}
	return lines;
}

function workersSection(ctx: Ctx, m: MachineView, w: number): Line[] {
	const h = ctx.models.home;
	const lines: Line[] = [
		head("WORKERS", "", w),
		h.runningChildren
			? [
					{ text: String(h.runningChildren), role: "running" },
					{
						text: ` running across ${h.inSession} run${h.inSession === 1 ? "" : "s"}`,
						role: "ink2",
					},
				]
			: [{ text: "none running", role: "dim" }],
	];
	if (m.slots) {
		const s = m.slots;
		lines.push([
			{ text: "slots  ", role: "dim" },
			{ text: `${s.used}/${s.used + s.free}`, role: s.free ? "ink" : "warn" },
			{
				text: ` · cap ${s.cap} · memory fits ${s.memory} more at ${size(s.perWorkerMb)}`,
				role: "dim",
			},
		]);
	}
	return [...lines, ...accountLines(ctx, m, w)];
}

/** Each account: how many live workers run under it, or the usage limit it waits out. */
function accountLines(ctx: Ctx, m: MachineView, w: number): Line[] {
	if (!m.accounts?.length) return [];
	const running = new Map<string, number>();
	for (const r of ctx.models.home.runs)
		for (const c of r.children) {
			const k = c.worker;
			if (c.state !== "running" || k?.kind !== "detached" || !k.account)
				continue;
			if (k.status !== "alive" && k.status !== undefined) continue;
			running.set(k.account, (running.get(k.account) ?? 0) + 1);
		}
	const N = Math.min(
		NAME_MAX,
		Math.max(...m.accounts.map((a) => strWidth(a.name))),
	);
	return [
		[{ text: "accounts", role: "dim" }],
		...m.accounts.map((a): Line => {
			const n = running.get(a.name) ?? 0;
			const bench = a.notLoggedIn
				? "not logged in"
				: a.limitedUntil && `limited until ${hhmm(a.limitedUntil)}`;
			const state: Span[] = bench
				? [
						{ text: bench, role: "warn" },
						...(a.reason && !ctx.narrow
							? [{ text: ` · ${a.reason}`, role: "dim" as Role }]
							: []),
					]
				: [{ text: "available", role: "dim" }];
			return truncate(
				[
					sp(2),
					...cell(a.name, N, "ink"),
					sp(2),
					n
						? { text: `${n} running`, role: "running" }
						: { text: "idle", role: "dim" },
					{ text: " · ", role: "dim" },
					...state,
				],
				w,
			);
		}),
	];
}

/** Name columns stop growing here, so a figure never sits far from what it belongs to. */
const NAME_MAX = 24;

function worktreeSection(
	ctx: Ctx,
	m: MachineView,
	w: number,
	max: number,
): Line[] {
	const trees = m.worktrees;
	const total = trees?.reduce((s, t) => s + t.mb, 0) ?? 0;
	const lines: Line[] = [
		head(
			"WORKTREES",
			trees?.length ? `${trees.length} · ${size(total)}` : "",
			w,
		),
	];
	if (!trees) return [...lines, [{ text: "measuring…", role: "dim" }]];
	if (!trees.length)
		return [...lines, [{ text: "no child worktrees on disk", role: "dim" }]];
	const K = Math.min(
		NAME_MAX,
		Math.max(8, ...trees.map((t) => strWidth(t.key))),
	);
	const top = Math.max(1, ...trees.map((t) => t.mb));
	// The repository each tree belongs to, shown only when they are not all one.
	const repo = (p: string) => basename(dirname(p));
	const repos = new Set(trees.map((t) => repo(t.path)));
	const repoW = Math.min(NAME_MAX, w - K - 2 - 8 - 2 - 8 - 2);
	for (const t of trees.slice(0, max))
		lines.push([
			...cell(t.key, K, "ink"),
			sp(2),
			...rcell(size(t.mb), 8, t.stale ? "dim" : "ink2"),
			sp(2),
			...bar(ctx, t.mb / top, 8, "ink2"),
			...(repos.size > 1 && repoW >= 6
				? [sp(2), ...cell(repo(t.path), repoW, "dim")]
				: []),
		]);
	if (trees.length > max)
		lines.push([{ text: `${trees.length - max} more`, role: "dim" }]);
	return lines;
}

function procSection(m: MachineView, w: number, max: number): Line[] {
	const lines: Line[] = [head("TOP PROCESSES", "by memory", w)];
	if (!m.procs) return [...lines, [{ text: "sampling…", role: "dim" }]];
	const nameW = Math.min(NAME_MAX, Math.max(8, w - 25));
	lines.push([
		...rcell("PID", 7, "faint"),
		sp(2),
		...cell("NAME", nameW, "faint"),
		...rcell("MEM", 9, "faint"),
		sp(2),
		...rcell("CPU", 5, "faint"),
	]);
	for (const p of m.procs.slice(0, max))
		lines.push([
			...rcell(String(p.pid), 7, "dim"),
			sp(2),
			...cell(p.name, nameW, "ink"),
			...rcell(size(p.rssMb), 9, "ink2"),
			sp(2),
			...rcell(p.cpu === undefined ? "—" : `${Math.round(p.cpu)}%`, 5, "dim"),
		]);
	return lines;
}

const join = (sections: Line[][]): Line[] =>
	sections.flatMap((s, i) => (i ? [[], ...s] : s));

/** The Machine page: two columns from 100 columns, one below. */
export function machineBody(ctx: Ctx): Line[] {
	const m = ctx.models.machine;
	const at = ctx.narrow ? 2 : 3;
	if (!m) return [[sp(at), { text: "sampling the machine…", role: "dim" }]];
	const avail = ctx.size.rows - 4 - 2;
	if (ctx.narrow) {
		const w = ctx.W - at - 1;
		// Portia's own figures first, then what runs out first: memory, then disk.
		return join([
			workersSection(ctx, m, w),
			memSection(ctx, m, w),
			diskSection(ctx, m, w),
			cpuSection(ctx, m, w),
			worktreeSection(ctx, m, w, 5),
			procSection(m, w, 5),
		]).map((l) => [sp(at), ...truncate(l, w)]);
	}
	const gap = 4;
	const total = ctx.W - at - 1;
	const lw = Math.floor((total - gap) / 2);
	const rw = total - gap - lw;
	const left = join([
		cpuSection(ctx, m, lw),
		memSection(ctx, m, lw),
		diskSection(ctx, m, lw),
	]);
	const fixed = workersSection(ctx, m, rw).length + 1;
	const trees = worktreeSection(ctx, m, rw, 5);
	const procs = Math.max(3, Math.min(10, avail - fixed - trees.length - 1 - 2));
	const right = join([
		workersSection(ctx, m, rw),
		trees,
		procSection(m, rw, procs),
	]);
	const n = Math.max(left.length, right.length);
	return Array.from({ length: n }, (_, i) => [
		sp(at),
		...pad(truncate(left[i] ?? [], lw), lw),
		sp(gap),
		...truncate(right[i] ?? [], rw),
	]);
}
