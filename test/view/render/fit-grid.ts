import { describe, expect, it } from "vitest";
import { parseViewArgs, stateFor } from "../../../src/view/args";
import { readHome } from "../../../src/view/model/home";
import { render } from "../../../src/view/render";
import type { Ink } from "../../../src/view/render/ink";
import { strWidth } from "../../../src/view/render/text";
import { fixtureFs, HOME, MACHINE, NOW, SCREENS, visible } from "../helpers";

const home = readHome(fixtureFs(), HOME, NOW);
export const INKS: Ink[] = [
	{ depth: 24, theme: "dark", unicode: true, motion: true },
	{ depth: 0, theme: "dark", unicode: false, motion: false },
];

/**
 * The full grid takes over a minute on one core, and vitest runs the tests in
 * a file one after another, so it is cut into bands of widths, each swept in
 * its own fit-<from>.test.ts file, and the files run side by side.
 * fit.test.ts checks the bands cover 60 to 160 with no gap.
 */
export const FIT_BANDS: [number, number][] = [
	[60, 84],
	[85, 109],
	[110, 134],
	[135, 160],
];

/** §15.3: every screen at every size from 60 × 16 to 160 × 50 has exactly `rows` lines, none too wide. */
export function everyFrameFits(from: number): void {
	const band = FIT_BANDS.find(([lo]) => lo === from);
	if (!band) throw new Error(`no band of widths starts at ${from}`);
	const [lo, hi] = band;
	describe(`every frame fits, ${lo} to ${hi} columns`, () => {
		for (const [name, args] of SCREENS)
			it(name, () => {
				const state = stateFor(parseViewArgs(args, false), home, NOW);
				for (const ink of INKS)
					for (let cols = lo; cols <= hi; cols++)
						for (let rows = 16; rows <= 50; rows += ink.depth ? 1 : 7) {
							const out = render(
								state,
								{ home, machine: MACHINE },
								ink,
								{ cols, rows },
								{ now: NOW, frozen: true },
							);
							expect(out.lines.length).toBe(rows);
							for (const line of out.lines) {
								const w = strWidth(visible(line));
								if (w > cols - 1)
									expect.fail(
										`${name} ${cols}×${rows}: ${w} cells: ${visible(line)}`,
									);
							}
						}
			});
	});
}
