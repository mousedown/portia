import { describe, expect, it } from "vitest";
import { span, tokensFine } from "../../../src/view/model/format";
import { readHome } from "../../../src/view/model/home";
import { runProgress, waveProgress } from "../../../src/view/model/progress";
import type { ChildView, RunView } from "../../../src/view/model/types";
import { makeCtx } from "../../../src/view/render/common";
import { type Ink, sgr } from "../../../src/view/render/ink";
import {
	asciiCells,
	barCells,
	progressBar,
	type StatCols,
	statsLine,
	statsWidth,
} from "../../../src/view/render/progress";
import { lineWidth } from "../../../src/view/render/text";
import { initialState } from "../../../src/view/runtime/state";
import { fixtureFs, frame, HOME, NOW, visible } from "../helpers";

const ink = (o: Partial<Ink> = {}): Ink => ({
	depth: 24,
	theme: "dark",
	unicode: true,
	motion: false,
	...o,
});
const home = readHome(fixtureFs(), HOME, NOW);
const ctxOf = (i: Ink) =>
	makeCtx(initialState(), { home }, i, { cols: 120, rows: 36 }, { now: NOW });
const bar = (i: Ink, done: number, total: number, w = 8) =>
	sgr(progressBar(ctxOf(i), done, total, w, "accent"), i);

describe("the bar's maths", () => {
	it("is empty at 0% and full at 100%", () => {
		expect(barCells(0, 5, 20)).toEqual({ full: 0, part: 0 });
		expect(barCells(5, 5, 20)).toEqual({ full: 20, part: 0 });
		expect(barCells(0, 0, 20)).toEqual({ full: 0, part: 0 });
	});
	it("ends in an eighth-block edge", () => {
		// A third of 20 cells is 53⅓ eighths: six whole cells and five eighths.
		expect(barCells(1, 3, 20)).toEqual({ full: 6, part: 5 });
		expect(barCells(1, 2, 7)).toEqual({ full: 3, part: 4 });
	});
	it("shows anything started, and keeps track until done", () => {
		expect(barCells(1, 1000, 8)).toEqual({ full: 0, part: 1 });
		expect(barCells(999, 1000, 8)).toEqual({ full: 7, part: 7 });
		expect(asciiCells(1, 1000, 8)).toBe(1);
		expect(asciiCells(999, 1000, 8)).toBe(7);
		expect(asciiCells(1, 2, 8)).toBe(4);
	});
	it("draws a thin ━ rule on a ─ track, = on - in ASCII, the same at every depth", () => {
		expect(bar(ink({ depth: 0 }), 1, 2)).toBe("━━━━────");
		expect(bar(ink({ depth: 0 }), 1, 3)).toBe("━━╸─────");
		expect(bar(ink({ depth: 0, unicode: false }), 1, 3)).toBe("===-----");
		expect(bar(ink({ depth: 0 }), 0, 0)).toBe("────────");
		expect(bar(ink({ depth: 0 }), 3, 3)).toBe("━━━━━━━━");
		// Anything started shows; anything short of done is never a solid rule.
		expect(bar(ink({ depth: 0 }), 1, 1000)).toBe("╸───────");
		expect(bar(ink({ depth: 0 }), 999, 1000)).toBe("━━━━━━━╸");
		for (const depth of [16, 256, 24] as const)
			expect(visible(bar(ink({ depth }), 1, 3))).toBe("━━╸─────");
	});
	it("keeps the fill quiet while all is well, and colours it only when the run needs you", () => {
		const calm = progressBar(ctxOf(ink()), 1, 2, 8, "accent");
		expect(calm[0]).toMatchObject({ text: "━━━━", role: "ink2" });
		expect(calm.at(-1)).toMatchObject({ text: "────", role: "faint" });
		const spans = progressBar(ctxOf(ink()), 1, 2, 8, "warn");
		expect(spans[0]).toMatchObject({ text: "━━━━", role: "warn" });
		expect(progressBar(ctxOf(ink()), 1, 2, 8, "failed")[0]?.role).toBe(
			"failed",
		);
		expect(lineWidth(progressBar(ctxOf(ink()), 1, 3, 12, "failed"))).toBe(12);
	});
	it("fills amber without reverse video at 16 colours", () => {
		for (const theme of ["dark", "light"] as const) {
			const i = ink({ depth: 16, theme });
			const out = sgr(progressBar(ctxOf(i), 2, 5, 12, "warn"), i);
			expect(out).toContain("33m━");
			expect(out).not.toContain("7;");
		}
	});
});

describe("progress", () => {
	const child = (state: ChildView["state"], tokens = 0): ChildView =>
		({ state, tokens, attempts: [] }) as unknown as ChildView;
	it("counts closed children as done", () => {
		const r = {
			children: [
				child("landed"),
				child("closed"),
				child("running"),
				child("ready"),
			],
		} as unknown as RunView;
		expect(runProgress(r, NOW)).toMatchObject({
			done: 2,
			total: 4,
			live: true,
		});
	});
	it("counts from the first row to now while a child runs, else to the last row", () => {
		const r500 = home.runs.find((r) => r.key === "ACME-500") as RunView;
		const live = runProgress(r500, NOW);
		expect(live.elapsedMs).toBe(NOW - Date.parse(r500.startedAt ?? ""));
		const r377 = home.runs.find((r) => r.key === "ACME-377") as RunView;
		const done = runProgress(r377, NOW);
		expect(done.live).toBe(false);
		expect(done.elapsedMs).toBe(
			Date.parse(r377.lastAt ?? "") - Date.parse(r377.startedAt ?? ""),
		);
		const quiet = {
			...r500,
			children: r500.children.map((c) =>
				c.state === "running" ? { ...c, phase: "quiet" } : c,
			),
		} as RunView;
		const stalled = runProgress(quiet, NOW);
		expect(stalled.live).toBe(false);
		expect(stalled.elapsedMs).toBe(
			Date.parse(r500.lastAt ?? "") - Date.parse(r500.startedAt ?? ""),
		);
		const pending = r500.waves.at(-1);
		expect(pending && waveProgress(pending, NOW).elapsedMs).toBeUndefined();
	});
});

describe("formatting", () => {
	it("writes a span compactly", () => {
		expect(span(42_000)).toBe("42s");
		expect(span(100_000)).toBe("1m40s");
		expect(span(65_000)).toBe("1m05s");
		expect(span((37 * 60 + 32) * 1000)).toBe("37m32s");
		expect(span((4 * 60 + 12) * 60_000)).toBe("4h12m");
		expect(span((28 * 60 + 5) * 60_000)).toBe("1d4h");
		expect(span(-5)).toBe("0s");
	});
	it("writes tokens to a tenth of a thousand", () => {
		expect(tokensFine(842)).toBe("842");
		expect(tokensFine(599_120)).toBe("599.1k");
		expect(tokensFine(336_000)).toBe("336.0k");
		expect(tokensFine(999_949)).toBe("999.9k");
		expect(tokensFine(999_950)).toBe("1.00M");
		expect(tokensFine(1_284_000)).toBe("1.28M");
	});
	it("keeps the figures in fixed columns, blank where a figure is missing", () => {
		const c: StatCols = {
			N: 5,
			D: 6,
			T: 6,
			plus: true,
			tok: true,
			word: false,
		};
		const a = statsLine(c, { n: "3/4", d: "37m32s", t: "599.1k" });
		const b = statsLine(c, { n: "a2", d: "1m40s", t: "336.0k+" });
		const e = statsLine(c, { n: "0/6" });
		const text = (l: typeof a) => l.map((s) => s.text).join("");
		expect(text(a)).toBe("  3/4   37m32s   599.1k ");
		const worded = statsLine(
			{ ...c, word: true },
			{ n: "3/4", d: "1m", t: "9k" },
		);
		expect(text(worded)).toContain("     9k tokens ");
		expect(text(b)).toBe("   a2    1m40s   336.0k+");
		expect(text(e).trimEnd()).toBe("  0/6");
		for (const l of [a, b, e]) expect(lineWidth(l)).toBe(statsWidth(c));
	});
});

describe("narrow widths", () => {
	// A run's row is the one with a bar on it; the dock's rows have none.
	const at = (cols: number, args: string[] = []) =>
		frame([...args, "--width", String(cols), "--height", "36", "--depth", "0"])
			.split("\n")
			.filter((l) => /^[ ▌] {1,3}\S ACME-\d+ /.test(l) && /[━─]/.test(l));
	const barOf = (l: string) =>
		/^[━╸─]+/.exec(l.slice(l.search(/[━─]/)))?.[0] ?? "";

	it("keeps one row per run and every bar in one column, at every width", () => {
		for (let cols = 60; cols <= 160; cols++) {
			const rows = at(cols);
			expect(rows.length, `${cols}`).toBe(6);
			const starts = new Set(rows.map((l) => l.search(/[━─]/)));
			expect(starts.size, `${cols}`).toBe(1);
			const widths = new Set(rows.map((l) => [...barOf(l)].length));
			expect(widths.size, `${cols}`).toBe(1);
			expect([...widths][0], `${cols}`).toBeGreaterThanOrEqual(8);
			for (const l of rows) expect([...l].length).toBeLessThanOrEqual(cols - 1);
		}
	});
	it("gives way in order: the word, the summary to 24, the bar to 12, then the summary to 12, keeping the tokens", () => {
		const row = (cols: number) =>
			at(cols).find((l) => l.includes("ACME-500")) ?? "";
		expect(row(120)).toContain("662k tokens");
		expect([...barOf(row(120))].length).toBe(20);
		expect(row(100)).not.toContain("tokens");
		expect(row(100)).not.toContain("…");
		// The summary is cut to its cap before any bar shrinks.
		expect(row(90)).toContain("…");
		expect([...barOf(row(90))].length).toBe(20);
		expect([...barOf(row(72))].length).toBe(12);
		expect(row(72)).toContain("…");
		expect(row(72)).toContain("662k");
		expect(row(60)).toContain("4/8");
		expect(row(60)).toContain("662k");
	});
	it("holds the columns still while the clock ticks past a width", () => {
		const r500 = home.runs.find((r) => r.key === "ACME-500") as RunView;
		const start = Date.parse(r500.startedAt ?? "");
		const dots = (t: number) =>
			frame([
				"--width",
				"120",
				"--height",
				"36",
				"--depth",
				"0",
				"--now",
				new Date(t).toISOString(),
			])
				.split("\n")
				.filter((l) => /^[ ▌] {1,3}\S ACME-\d+ /.test(l) && /[█░]/.test(l))
				// Where each figure after the bar ends: they are right-aligned in fixed columns.
				.map((l) => {
					const cs = [...l];
					const from =
						cs.length -
						1 -
						[...cs].reverse().findIndex((ch) => /[█░▏▎▍▌▋▊▉]/.test(ch));
					return cs.flatMap((ch, i) =>
						i > from && ch !== " " && (cs[i + 1] ?? " ") === " " ? [i] : [],
					);
				});
		for (const at of [599_000, 3_599_000]) {
			const a = dots(start + at);
			const b = dots(start + at + 1000);
			expect(b).toEqual(a);
		}
	});
	it("lines the Run screen's figures up under one another", () => {
		for (const cols of [60, 72, 100, 120, 160]) {
			const lines = frame([
				"ACME-500",
				"--width",
				String(cols),
				"--height",
				"36",
				"--depth",
				"0",
			]).split("\n");
			const figs = lines.filter((l) => /\d+m\d\ds|\dh\d\dm/.test(l));
			const ends = new Set(
				figs.map((l) => l.search(/ · +(\d+m\d\ds|\dh\d\dm)/)),
			);
			expect(ends.size, `${cols}`).toBe(1);
			for (const l of lines)
				expect([...l].length).toBeLessThanOrEqual(cols - 1);
		}
	});
});
