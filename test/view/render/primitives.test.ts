import { describe, expect, it } from "vitest";
import type { Ctx } from "../../../src/view/render/common";
import { glyphs } from "../../../src/view/render/glyphs";
import {
	contrast,
	detectInk,
	hexOf,
	type Ink,
	mix,
	PALETTE,
	parseOsc11,
	sgr,
	shade,
} from "../../../src/view/render/ink";
import {
	ASCII_HERO,
	BREATH,
	compact,
	finialFg,
	HERO,
	HERO_WIDTH,
	hero,
} from "../../../src/view/render/logo";
import { reqFit } from "../../../src/view/render/screens/reqs";
import {
	cellWidth,
	cut,
	cutLeft,
	lineWidth,
	lr,
	strWidth,
	truncate,
} from "../../../src/view/render/text";

const ink = (o: Partial<Ink> = {}): Ink => ({
	depth: 24,
	theme: "dark",
	unicode: true,
	motion: true,
	...o,
});

describe("cellWidth", () => {
	it("counts wide, combining and ambiguous characters", () => {
		expect([..."a◆○·…▌"].map(cellWidth)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(cellWidth("界")).toBe(2);
		expect(cellWidth("́")).toBe(0);
		expect(cellWidth("‍")).toBe(0);
		expect(strWidth("é界")).toBe(3);
	});
	it("cuts wide text on cell boundaries", () => {
		expect(cut("界界界", 4)).toBe("界…");
		expect(strWidth(cut("界界界", 4))).toBe(3);
		expect(
			lineWidth(truncate([{ text: "ab" }, { text: "界界界" }], 5)),
		).toBeLessThanOrEqual(5);
	});
	it("gives the right side priority", () => {
		const l = lr([{ text: "a long left side" }], [{ text: "right" }], 12);
		expect(l.map((s) => s.text).join("")).toBe("a lo…  right");
	});
	it("cuts paths from the left, keeping the file", () => {
		expect(cutLeft("packages/app/src/components/Pane.tsx", 20)).toBe(
			"…components/Pane.tsx",
		);
		expect(cutLeft("src/a.ts", 20)).toBe("src/a.ts");
	});
	it("measures emoji as two cells and controls as the space they are painted as", () => {
		expect([..."✅❌🫠⭐"].map(cellWidth)).toEqual([2, 2, 2, 2]);
		expect([..."✓✗✔"].map(cellWidth)).toEqual([1, 1, 1]);
		expect(strWidth("✔️")).toBe(1);
		expect(strWidth("a\tb")).toBe(3);
	});
	it("marks a cut that lands on a span boundary", () => {
		const l = truncate(
			[{ text: "related-unit" }, { text: " " }, { text: "✓" }],
			12,
		);
		expect(l.map((s) => s.text).join("")).toBe("related-uni…");
		expect(lineWidth(l)).toBe(12);
	});
});

describe("the palette", () => {
	const TEXT = ["ink", "ink2", "dim", "accent", "accentBright"] as const;
	const STATE = [
		"pending",
		"ready",
		"running",
		"parked",
		"failed",
		"done",
		"landed",
	] as const;
	it("keeps text at 4.5:1 and states at 4.5:1 dark, 4.3:1 light", () => {
		for (const r of TEXT) {
			expect(contrast(hexOf(r, "dark"), "#1B1B1F"), r).toBeGreaterThanOrEqual(
				4.5,
			);
			expect(contrast(hexOf(r, "light"), "#FFFFFF"), r).toBeGreaterThanOrEqual(
				4.5,
			);
		}
		for (const r of STATE) {
			expect(contrast(hexOf(r, "dark"), "#1B1B1F"), r).toBeGreaterThanOrEqual(
				4.5,
			);
			expect(contrast(hexOf(r, "light"), "#FFFFFF"), r).toBeGreaterThanOrEqual(
				4.3,
			);
		}
		// The machine's amber stands with the states: it always comes with a figure.
		expect(contrast(hexOf("warn", "dark"), "#1B1B1F")).toBeGreaterThanOrEqual(
			4.5,
		);
		expect(contrast(hexOf("warn", "light"), "#FFFFFF")).toBeGreaterThanOrEqual(
			4.3,
		);
		expect(Object.keys(PALETTE)).toContain("selBg");
	});
	it("mixes in OKLab, ends exact", () => {
		expect(mix("#F5DC9A", "#E79BB4", 0)).toBe("#F5DC9A");
		expect(mix("#F5DC9A", "#E79BB4", 1)).toBe("#E79BB4");
	});
});

describe("sgr", () => {
	const line = [
		{ text: "a", role: "ink" as const },
		{ text: "b", role: "ink" as const },
		{ text: "c", role: "failed" as const },
	];
	it("coalesces runs of one style and resets at the end", () => {
		const out = sgr(line, ink());
		expect(out).toBe(
			"\x1b[0;38;2;232;228;220mab\x1b[0;38;2;240;120;122mc\x1b[0m",
		);
	});
	it("emits nothing but text at depth 0, and ASCII when asked", () => {
		expect(sgr(line, ink({ depth: 0 }))).toBe("abc");
		expect(sgr([{ text: "✓ ·…" }], ink({ depth: 0, unicode: false }))).toBe(
			"+ .~",
		);
	});
	it("never passes an escape through from file text", () => {
		expect(sgr([{ text: "a\x1b[2Jb" }], ink({ depth: 0 }))).toBe("a [2Jb");
	});
	it("uses 256 and 16 colour codes", () => {
		expect(
			sgr([{ text: "x", role: "running" }], ink({ depth: 256 })),
		).toContain("38;5;111");
		expect(sgr([{ text: "x", role: "running" }], ink({ depth: 16 }))).toContain(
			"\x1b[0;36m",
		);
	});
});

describe("detectInk", () => {
	it("follows NO_COLOR, TERM, COLORTERM and the flags", () => {
		expect(detectInk({ COLORTERM: "truecolor" }, true).depth).toBe(24);
		expect(detectInk({ TERM: "xterm-256color" }, true).depth).toBe(256);
		expect(detectInk({ TERM: "xterm" }, true).depth).toBe(16);
		expect(
			detectInk({ NO_COLOR: "", COLORTERM: "truecolor" }, true),
		).toMatchObject({ depth: 0, motion: false });
		expect(detectInk({ COLORTERM: "truecolor" }, false).depth).toBe(0);
		expect(detectInk({ TERM: "dumb" }, true).depth).toBe(0);
		expect(detectInk({ PORTIA_ASCII: "1" }, true).unicode).toBe(false);
		expect(
			detectInk({ PORTIA_REDUCED_MOTION: "1", COLORTERM: "24bit" }, true)
				.motion,
		).toBe(false);
		expect(detectInk({}, true, undefined, { depth: 256 }).depth).toBe(256);
	});
	it("reads the theme from PORTIA_THEME, the OSC 11 reply, then COLORFGBG", () => {
		expect(detectInk({ PORTIA_THEME: "light" }, true).theme).toBe("light");
		expect(detectInk({}, true, "\x1b]11;rgb:ffff/ffff/ffff\x07").theme).toBe(
			"light",
		);
		expect(detectInk({}, true, "rgb:1b1b/1b1b/1f1f").theme).toBe("dark");
		expect(detectInk({ COLORFGBG: "0;15" }, true).theme).toBe("light");
		expect(detectInk({ COLORFGBG: "15;0" }, true).theme).toBe("dark");
		expect(parseOsc11("rgb:ff/80/00")).toBe("#ff8000");
	});
});

describe("the logo", () => {
	it("is 9 rows: the hero and the ASCII hero both 62 wide", () => {
		expect(HERO).toHaveLength(9);
		expect(ASCII_HERO).toHaveLength(9);
		expect(HERO_WIDTH).toBe(62);
		expect(Math.max(...HERO.map(strWidth))).toBe(62);
		expect(Math.max(...ASCII_HERO.map((l) => l.length))).toBe(62);
		expect(ASCII_HERO.join("")).toMatch(/^[\x20-\x7e]*$/);
		expect(HERO[0]?.indexOf("◆")).toBe(7);
	});
	it("is symmetric about the post, and the word stands from the beam to the base", () => {
		const flip = (s: string) =>
			[...s].map((c) => (c === "╱" ? "╲" : c === "╲" ? "╱" : c)).join("");
		for (const row of HERO) {
			const scales = row.padEnd(15).slice(0, 15);
			expect([...scales.slice(8)].reverse().join("")).toBe(
				flip(scales.slice(0, 7)),
			);
		}
		// Cap line on the beam's row, the shadow's line on the base's: the word fills rows 1–6.
		for (const r of [1, 2, 3, 4, 5]) expect([...(HERO[r] ?? "")][17]).toBe("█");
		expect([...(HERO[6] ?? "")][17]).toBe("╚");
		expect(HERO[1]?.slice(2, 13)).toBe("▀▀▀▀▀█▀▀▀▀▀");
		expect(HERO[6]?.slice(3, 12)).toBe("▀▀▀▀▀▀▀▀▀");
	});
	it("paints the faces gold to rose, column by column, and the shadows a deeper shade", () => {
		const at = (r: number, col: number, theme: "dark" | "light" = "dark") => {
			let c = 0;
			for (const s of hero(ink({ theme }), { finial: "idle", breath: 0 })[r] ??
				[]) {
				if (c === col) return s.fg?.hex;
				c += strWidth(s.text);
			}
		};
		expect(at(1, 17)).toBe("#F5DC9A");
		expect(at(2, 60)).toBe("#E89CB2");
		// The A's ╗ is the last column: the rose, deepened, not a grey.
		expect(at(2, 61)).toBe(shade("#E79BB4", 0.6, 1.1));
		expect(at(2, 61, "light")).toBe(shade("#A23E6A", 0.78, 1));
		const sh = at(1, 23) ?? "";
		expect(contrast(sh, "#1B1B1F")).toBeLessThan(
			contrast(at(1, 22) ?? "", "#1B1B1F"),
		);
	});
	it("tells the state with the finial", () => {
		expect(finialFg(ink(), "idle", 0).hex).toBe("#F7DE9C");
		expect(finialFg(ink({ theme: "light" }), "idle", 0).hex).toBe("#8F6410");
		expect(finialFg(ink(), "parked", 0).hex).toBe("#D3A0E6");
		expect(finialFg(ink(), "running", 0).hex).toBe(`#${BREATH.dark[0]}`);
		expect(finialFg(ink(), "running", 12).hex).toBe(`#${BREATH.dark[12]}`);
		expect(finialFg(ink(), "running", 20).hex).toBe(`#${BREATH.dark[4]}`);
		expect(finialFg(ink({ depth: 256 }), "running", 3).hex).toBe("#7DB8F5");
	});
	it("has a compact mark in three widths", () => {
		const w = (f: "wide" | "narrow" | "mark") =>
			lineWidth(compact(ink(), f, "idle", 0));
		expect([w("wide"), w("narrow"), w("mark")]).toEqual([13, 8, 1]);
		expect(
			compact(ink({ unicode: false, depth: 0 }), "narrow", "idle", 0)
				.map((s) => s.text)
				.join(""),
		).toBe("o PORTIA");
	});
});

describe("the ledger's req column", () => {
	const ctx = { g: glyphs(true) } as unknown as Ctx;
	const text = (r: { spans: { text: string }[] }) =>
		r.spans.map((s) => s.text).join("");
	const ids = (n: number, ok: (i: number) => boolean) =>
		Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, ok: ok(i) }));
	it("shows every id that fits, a count when they agree, failures first and +N otherwise", () => {
		expect(
			text(
				reqFit(
					ctx,
					ids(2, () => true),
					14,
				),
			),
		).toBe("F1 ✓ F2 ✓");
		expect(
			text(
				reqFit(
					ctx,
					ids(8, () => true),
					14,
				),
			),
		).toBe("8 ✓");
		const mixed = reqFit(
			ctx,
			ids(8, (i) => i !== 5),
			14,
		);
		expect(text(mixed)).toBe("F6 ✗ F1 ✓ +6");
		expect(mixed.width).toBeLessThanOrEqual(14);
	});
});
