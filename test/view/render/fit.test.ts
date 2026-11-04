import { describe, expect, it } from "vitest";
import { parseViewArgs, stateFor } from "../../../src/view/args";
import { readHome } from "../../../src/view/model/home";
import { render } from "../../../src/view/render";
import { strWidth } from "../../../src/view/render/text";
import { fixtureFs, HOME, NOW, visible } from "../helpers";
import { FIT_BANDS, INKS } from "./fit-grid";

/** The full sweep runs in the fit-<from>.test.ts files, side by side. */
describe("every frame fits", () => {
	it("the bands of widths cover 60 to 160 columns with no gap", () => {
		const cols = FIT_BANDS.flatMap(([lo, hi]) =>
			Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
		);
		expect(cols).toEqual(Array.from({ length: 101 }, (_, i) => 60 + i));
	});
});

describe("agent text fits", () => {
	it("an emoji, a variation selector and a tab never widen a row", () => {
		const msg = "✅ tests pass\t❌ lint 🫠 ✔️ and a long tail of words to cut";
		const row = JSON.stringify({
			at: "2026-10-20T14:02:30.000Z",
			child: "ACME-505",
			attempt: 2,
			stage: "result",
			status: "done",
			data: { message: msg },
		});
		const path = `${HOME}/runs/ACME-500/runlog.jsonl`;
		const text = `${fixtureFs().read(path) ?? ""}${row}\n`;
		const h = readHome(fixtureFs({ [path]: text }), HOME, NOW);
		for (const args of [
			["ACME-500", "ACME-505"],
			["ACME-500"],
			["--page", "activity"],
		]) {
			const state = stateFor(parseViewArgs(args, false), h, NOW);
			for (const ink of INKS)
				for (const cols of [60, 72, 100, 120]) {
					const out = render(
						state,
						{ home: h },
						ink,
						{ cols, rows: 36 },
						{ now: NOW, frozen: true },
					);
					for (const l of out.lines)
						expect(strWidth(visible(l)), visible(l)).toBeLessThanOrEqual(
							cols - 1,
						);
				}
		}
	});
});
