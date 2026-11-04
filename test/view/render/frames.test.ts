import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryFs } from "../../../src/view/model/fs";
import { fixtureFs, frame, SCREENS, visible } from "../helpers";

const SIZES: [number, number][] = [
	[120, 36],
	[72, 30],
	[60, 24],
];
const file = (name: string) =>
	join(import.meta.dirname, "__frames__", `${name}.txt`);
const size = (w: number, h: number) => [
	"--width",
	String(w),
	"--height",
	String(h),
];
const lines = (s: string) => s.split("\n").map((l) => l.trimEnd());
// A progress bar's track is a solid block at 256 colours and above, and `░` below.
const solid = (l: string[]) => l.map((x) => x.replaceAll("░", "█"));

describe("frames", () => {
	for (const [name, args] of SCREENS)
		for (const [w, h] of SIZES)
			it(`${name} at ${w}×${h}`, async () => {
				const plain = frame([...args, ...size(w, h), "--depth", "0"]);
				expect(plain).not.toContain("\x1b");
				await expect(`${plain}\n`).toMatchFileSnapshot(
					file(`${name}-${w}x${h}`),
				);
				// Colour never moves a cell: every depth has the same layout. The one
				// exception is the help card's backdrop, which is faint with colour and,
				// since faint cannot be told from normal text without it, blank at depth 0.
				for (const depth of ["16", "256", "24"]) {
					const coloured = lines(
						visible(frame([...args, ...size(w, h), "--depth", depth])),
					);
					if (name === "help") {
						// The card itself, border to border, is the same at every depth. It is
						// cut where it sits in the plain frame: in colour the faint page behind
						// it can hold box-drawing of its own, such as the run's map.
						const top = lines(plain).find((x) => x.includes("╭")) ?? "";
						const from = [...top].indexOf("╭");
						const to = [...top].lastIndexOf("╮") + 1;
						const card = (l: string[]) =>
							l.map((x) => [...x].slice(from, to).join(""));
						expect(card(coloured)).toEqual(card(lines(plain)));
					} else expect(solid(coloured)).toEqual(solid(lines(plain)));
				}
				const ascii = frame([
					...args,
					...size(w, h),
					"--depth",
					"0",
					"--ascii",
				]);
				expect(/^[\x20-\x7e\n]*$/.test(ascii), ascii).toBe(true);
				await expect(`${ascii}\n`).toMatchFileSnapshot(
					file(`${name}-${w}x${h}-ascii`),
				);
			});

	for (const theme of ["dark", "light"])
		for (const [name, args] of SCREENS.filter(([n]) =>
			["home", "run", "child", "worker"].includes(n),
		))
			it(`${name} in the ${theme} theme at depth 24`, async () => {
				await expect(
					`${frame([...args, "--depth", "24", "--theme", theme])}\n`,
				).toMatchFileSnapshot(file(`${name}-120x36-${theme}.sgr`));
			});

	it("an empty home shows the hero and how to start", async () => {
		const fs = memoryFs({ "/fx/runs/": "" });
		for (const [w, h] of [
			[120, 30],
			[72, 24],
			[64, 24],
		] as const)
			await expect(
				`${frame([...size(w, h), "--depth", "0"], { fs })}\n`,
			).toMatchFileSnapshot(file(`empty-${w}x${h}`));
	});

	it("a home with no plan snapshots keeps each row together at 180 columns", async () => {
		const fs = fixtureFs({}, (p) => !p.endsWith("plan.json"));
		const out = frame([...size(180, 24), "--depth", "0"], { fs });
		await expect(`${out}\n`).toMatchFileSnapshot(file("home-no-plans-180x24"));
		// No hole after the summary: the bar follows it, every bar in one column, and
		// the quiet trailing column (epic PR, last event) takes the room past the figures.
		const lines = out.split("\n");
		const rows = lines.filter((x) => /^[ ▌] \S ACME-\d+ +—/.test(x));
		expect(rows.length).toBeGreaterThan(3);
		const bars = rows.map((l) => l.search(/[█░]/));
		for (const l of rows) expect(l.indexOf("—")).toBeLessThan(20);
		expect(new Set(bars).size).toBe(1);
		expect(rows.find((l) => l.includes("ACME-500"))).toContain("#412");
	});

	it("keeps the hero over a list too long to fit, which scrolls under it", () => {
		const at29 = frame([...size(120, 29), "--depth", "0"]).split("\n");
		expect(at29[2]).toContain("██████╗");
		expect(at29.some((l) => /↓ \d+ more/.test(l))).toBe(true);
		// A row shorter, the hero gives way to the compact header and the strip.
		const at28 = frame([...size(120, 28), "--depth", "0"]).split("\n");
		expect(at28.join("\n")).not.toContain("██████╗");
		expect(at28[0]).toContain("◆ P O R T I A");
		expect(at28[1]).toMatch(/cpu .*mem .*disk /);
	});

	it("puts the strip under the hero when its graphics do not fit beside it", () => {
		const out = frame([...size(72, 30), "--depth", "0"]).split("\n");
		expect(out[2]).toContain("██████╗");
		expect(out[11]).toMatch(/cpu +[━╸─]+.*mem +[━╸─]+.*disk +[━╸─]+/);
	});

	it("says so when the terminal is too small", () => {
		expect(frame(size(59, 20))).toContain("portia view needs at least 60 × 16");
		expect(frame(size(80, 15))).toContain("portia view needs at least 60 × 16");
	});

	it("matches the §9.1 census and finial state at depth 24", () => {
		const out = frame(["--depth", "24"]);
		// Two runs need a person, so the finial is mauve (parked), not the breathing azure.
		expect(out.split("\n")[1]).toContain("\x1b[0;38;2;211;160;230m◆");
	});
});
