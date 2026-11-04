import { fgOf, type Ink, mix, shade } from "./ink";
import type { Fg, Line, Span } from "./text";

export type FinialState = "idle" | "running" | "parked";

const EPIGRAPH = "the quality of mercy is not strained";

/** PORTIA in figlet's ANSI Shadow: █ faces, box-drawing shadows. */
const WORDMARK = [
	"██████╗  ██████╗ ██████╗ ████████╗██╗ █████╗",
	"██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝██║██╔══██╗",
	"██████╔╝██║   ██║██████╔╝   ██║   ██║███████║",
	"██╔═══╝ ██║   ██║██╔══██╗   ██║   ██║██╔══██║",
	"██║     ╚██████╔╝██║  ██║   ██║   ██║██║  ██║",
	"╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝",
];
/** The same shape in ASCII: # for the faces, | and = for the shadows. */
const ASCII_WORDMARK = WORDMARK.map((row) =>
	[...row]
		.map((c) => (c === "█" ? "#" : c === "║" ? "|" : c === " " ? " " : "="))
		.join(""),
);
/** §7.1: the scales, columns 0–12, beam on the word's cap line and base on its shadow line. */
const LEVEL = [
	"       ◆",
	"  ▀▀▀▀▀█▀▀▀▀▀",
	"   ╱╲  █  ╱╲",
	"  ╱  ╲ █ ╱  ╲",
	"  ▀▀▀▀ █ ▀▀▀▀",
	"     ▄▄█▄▄",
	"   ▀▀▀▀▀▀▀▀▀",
];
const ASCII_LEVEL = [
	"       o",
	"  _____|_____",
	"   /\\  |  /\\",
	"  /  \\ | /  \\",
	"  \\__/ | \\__/",
	"     __|__",
	"   '-------'",
];
/** §7.4, the scales' columns only: left heavy, then right heavy, each a half row. */
const LEFT_HEAVY = [
	"       ◆",
	"  ▄▄▄▄▄█▀▀▀▀▀",
	"   ╱╲  █  ╱╲",
	"  ╱  ╲ █ ╱  ╲",
	"  ▄▄▄▄ █ ▀▀▀▀",
	"     ▄▄█▄▄",
	"   ▀▀▀▀▀▀▀▀▀",
];
const RIGHT_HEAVY = [
	"       ◆",
	"  ▀▀▀▀▀█▄▄▄▄▄",
	"   ╱╲  █  ╱╲",
	"  ╱  ╲ █ ╱  ╲",
	"  ▀▀▀▀ █ ▄▄▄▄",
	"     ▄▄█▄▄",
	"   ▀▀▀▀▀▀▀▀▀",
];
const SCALES_END = 12;
const WORD_START = 17;
const WORD_WIDTH = Math.max(...WORDMARK.map((r) => [...r].length));
/** The A's last column: the gradient runs from WORD_START to here. */
const WORD_END = WORD_START + WORD_WIDTH - 1;

const compose = (scales: string[], word: string[]) => [
	...scales.map((s, r) =>
		r >= 1 && r <= word.length ? `${s.padEnd(WORD_START)}${word[r - 1]}` : s,
	),
	`${" ".repeat(WORD_START)}${EPIGRAPH}`,
	// A quiet row under the quote, so the hero keeps its nine rows beside the machine.
	"",
];
export const HERO = compose(LEVEL, WORDMARK);
/** §7.3. */
export const ASCII_HERO = compose(ASCII_LEVEL, ASCII_WORDMARK);
export const HERO_WIDTH = WORD_END + 1;
export const HERO_ROWS = HERO.length;
/** The word's rows in the hero. */
const WORD_ROWS = { first: 1, last: WORDMARK.length };

const SCALES = {
	dark: [
		"#F7E2A8",
		"#F0CF85",
		"#E7BE6B",
		"#E0B25C",
		"#D4A04E",
		"#C68E43",
		"#B57C3A",
	],
	dark256: [223, 222, 179, 179, 179, 172, 137],
	light: [
		"#B98A2E",
		"#AD7D28",
		"#A07222",
		"#93661C",
		"#875A17",
		"#7B4F13",
		"#6E4511",
	],
	light256: [136, 136, 130, 94, 94, 94, 58],
};
const WORD = {
	dark: "F5DC9A F5DA99 F5D899 F5D698 F5D497 F5D397 F5D196 F4CF95 F4CD95 F4CB94 F4C993 F4C793 F4C592 F4C391 F3C191 F3BF90 F3BE8F F3BC8F F3BA8E F2B88D F2B68D F2B48C F1B38E F1B290 F0B192 F0AF95 EFAE97 EFAD99 EEAC9B EEAB9D EDAA9E EDA8A0 ECA7A2 ECA6A4 EBA5A6 EBA4A8 EAA2AA EAA1AB E9A0AD E99FAF E89EB1 E89CB2 E79BB4".split(
		" ",
	),
	light:
		"946812 956715 976718 98661B 9A651D 9B641F 9C6322 9E6324 9F6226 A06127 A26029 A35F2B A45F2D A65E2E A75D30 A85C31 AA5B33 AB5A34 AC5936 AD5837 AF5739 B0563A AF553D AF5440 AE5343 AD5246 AD5148 AC504B AB4F4D AB4E4F AA4D52 A94C54 A84A56 A84958 A7485A A7475D A6465F A54561 A54362 A44264 A34166 A33F68 A23E6A".split(
			" ",
		),
	dark256: [222, 223, 216, 216, 181, 181],
	light256: [94, 130, 130, 131, 131, 125],
	shadowDark256: [94, 94, 94, 95, 95, 95],
	shadowLight256: [58, 94, 94, 88, 89, 89],
	compactDark: [
		"#F5DC9A",
		"#F4CC94",
		"#F3BC8F",
		"#F0AF95",
		"#EBA5A5",
		"#E79BB4",
	],
	compactLight: [
		"#946812",
		"#A06226",
		"#AB5A34",
		"#AD5246",
		"#A7495A",
		"#A23E6A",
	],
};
/** §7.5: frame f uses BREATH[f ≤ 12 ? f : 24 − f]. */
export const BREATH = {
	dark: "4C6E93 4D6F95 4F7399 5378A1 5880AB 5E89B6 6492C3 6A9CD0 70A5DC 76ADE6 7AB3EE 7CB7F3 7DB8F5".split(
		" ",
	),
	light:
		"7FA6D3 7DA5D3 79A2D1 729DCF 6897CD 5E8FCA 5287C6 457FC3 3A78BF 2F71BC 266CBA 1F69B8 1D68B8".split(
			" ",
		),
};
export const BREATH_FRAMES = 24;

/** Where each letter of P O R T I A starts, in word columns. */
const LETTERS = [0, 8, 17, 25, 34, 37];
const letterAt = (col: number) =>
	LETTERS.filter((start) => col - WORD_START >= start).length - 1;
/** The box-drawing cells of the word: its shadow, a deeper shade of the face beside it. */
const SHADOW = /[╗╔═║╚╝]/;
/** OKLab lightness and chroma of the shadow against its face, per theme. */
const DEPTH = {
	dark: { l: 0.6, c: 1.1 },
	light: { l: 0.78, c: 1 },
};

export function finialFg(ink: Ink, state: FinialState, breath: number): Fg {
	if (state === "parked") return fgOf("parked", ink.theme);
	if (state === "running") {
		const base = fgOf("running", ink.theme);
		if (ink.depth !== 24 || !ink.motion) return base;
		const f = ((breath % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES;
		return { ...base, hex: `#${BREATH[ink.theme][f <= 12 ? f : 24 - f]}` };
	}
	return fgOf(ink.theme === "dark" ? "accentBright" : "accent", ink.theme);
}

function wordFg(ink: Ink, col: number, shadow: boolean, gild?: number): Fg {
	// The 43 stops span the word, whatever its width: gold at the P, rose at the A.
	const last = WORD.dark.length - 1;
	const t = (col - WORD_START) / (WORD_END - WORD_START);
	const i = Math.min(last, Math.max(0, Math.round(t * last)));
	const letter = letterAt(col);
	const dark = ink.theme === "dark";
	let hex = `#${WORD[ink.theme][i]}`;
	let c256 =
		(shadow
			? dark
				? WORD.shadowDark256
				: WORD.shadowLight256
			: dark
				? WORD.dark256
				: WORD.light256)[letter] ?? 222;
	if (shadow) hex = shade(hex, DEPTH[ink.theme].l, DEPTH[ink.theme].c);
	if (gild !== undefined) {
		// The light sweeps the whole word in ten frames, from before the P to past the A.
		const at = WORD_START - 2 + ((WORD_WIDTH + 3) * gild) / 9;
		const d = Math.abs(col - at);
		const t = Math.max(0, 0.6 - 0.2 * d) * (shadow ? 0.5 : 1);
		if (t > 0) hex = mix(hex, dark ? "#FFF6DC" : "#FFFFFF", t);
		if (d <= 1 && !shadow) c256 = 230;
	}
	return { hex, c256 };
}

export interface HeroOpts {
	finial: FinialState;
	breath: number;
	/** An arrival frame: the scales columns to draw instead of the level ones. */
	scales?: string[];
	/** The gilding frame, 0–9. */
	gild?: number;
}

/** The hero, 9 rows by up to HERO_WIDTH cells, one span per painted cell. */
export function hero(ink: Ink, o: HeroOpts): Line[] {
	const art = ink.unicode ? HERO : ASCII_HERO;
	const tagRow = WORD_ROWS.last + 1;
	return art.map((row, r) => {
		const chars = [...row];
		if (o.scales && ink.unicode) {
			const s = [...(o.scales[r] ?? "")];
			for (let c = 0; c <= SCALES_END; c++) chars[c] = s[c] ?? " ";
		}
		const out: Span[] = [];
		const cell = (ch: string, c: number): Span => {
			if (ch === " " || ink.depth === 0) return { text: ch };
			if (c <= SCALES_END) {
				if (r === 0) return { text: ch, fg: finialFg(ink, o.finial, o.breath) };
				const idx = Math.min(r - 1, SCALES.dark.length - 1);
				const fg: Fg =
					ink.theme === "dark"
						? {
								hex: SCALES.dark[idx] ?? "#E0B25C",
								c256: SCALES.dark256[idx] ?? 179,
								c16: "33",
							}
						: {
								hex: SCALES.light[idx] ?? "#93661C",
								c256: SCALES.light256[idx] ?? 94,
								c16: "33",
							};
				return { text: ch, fg };
			}
			if (r >= WORD_ROWS.first && r <= WORD_ROWS.last && c >= WORD_START) {
				const shadow = ink.unicode ? SHADOW.test(ch) : ch !== "#";
				if (ink.depth === 16)
					return shadow ? { text: ch, role: "dim" } : { text: ch, bold: true };
				return { text: ch, fg: wordFg(ink, c, shadow, o.gild) };
			}
			return { text: ch };
		};
		chars.forEach((ch, c) => {
			out.push(cell(ch, c));
		});
		// The epigraph is words, not art: one span, leaning.
		if (r === tagRow && ink.depth !== 0)
			return [
				...out.slice(0, WORD_START),
				{ text: EPIGRAPH, role: "dim" as const, italic: true },
			];
		return out;
	});
}

export type MarkForm = "wide" | "narrow" | "mark";

/** `◆ P O R T I A`, `◆ PORTIA` or `◆`: the finial, in its state's colour, then the word. */
export function compact(
	ink: Ink,
	form: MarkForm,
	finial: FinialState,
	breath: number,
): Line {
	const out: Line = [
		{
			text: ink.unicode ? "◆" : "o",
			...(ink.depth === 0 ? {} : { fg: finialFg(ink, finial, breath) }),
		},
	];
	if (form === "mark") return out;
	out.push({ text: " " });
	const stops = ink.theme === "dark" ? WORD.compactDark : WORD.compactLight;
	const c256 = ink.theme === "dark" ? WORD.dark256 : WORD.light256;
	[..."PORTIA"].forEach((ch, i) => {
		if (i && form === "wide") out.push({ text: " " });
		if (ink.depth === 0) out.push({ text: ch });
		else if (ink.depth === 16) out.push({ text: ch, bold: true });
		else
			out.push({
				text: ch,
				fg: { hex: stops[i] ?? "#F5DC9A", c256: c256[i] ?? 222 },
			});
	});
	return out;
}

/** PORTIA in two rows of half blocks, one entry per letter, for the inner pages. */
const MINI_LETTERS = [
	["█▀█", "█▀▀"],
	["█▀█", "█▄█"],
	["█▀█", "█▀▄"],
	["▀█▀", " █ "],
	["█", "█"],
	["▄▀█", "█▀█"],
];
/** The scales cut to two rows: the finial over its beam. */
const MINI_MARK = [" ◆ ", "▀█▀"];

/** The cells the mini logo takes across. */
export const MINI_WIDTH =
	(MINI_MARK[0]?.length ?? 0) +
	1 +
	MINI_LETTERS.reduce((w, l, i) => w + (i ? 1 : 0) + (l[0]?.length ?? 0), 0);

/**
 * The logo for the inner pages, in two rows: the finial in its state's colour over the
 * scales' beam, then PORTIA in half blocks, each letter in the word's own stop. At 16
 * colours the word is bold; without colour it is plain.
 */
export function mini(ink: Ink, finial: FinialState, breath: number): Line[] {
	const stops = ink.theme === "dark" ? WORD.compactDark : WORD.compactLight;
	const c256 = ink.theme === "dark" ? WORD.dark256 : WORD.light256;
	const beam: Fg =
		ink.theme === "dark"
			? {
					hex: SCALES.dark[1] ?? "#E0B25C",
					c256: SCALES.dark256[1] ?? 179,
					c16: "33",
				}
			: {
					hex: SCALES.light[1] ?? "#93661C",
					c256: SCALES.light256[1] ?? 94,
					c16: "33",
				};
	return [0, 1].map((r): Line => {
		const out: Line = [];
		const markRow = MINI_MARK[r] ?? "";
		if (ink.depth === 0) out.push({ text: markRow });
		else if (r === 0)
			out.push(
				{ text: " " },
				{ text: "◆", fg: finialFg(ink, finial, breath) },
				{ text: " " },
			);
		else out.push({ text: markRow, fg: beam });
		out.push({ text: " " });
		MINI_LETTERS.forEach((l, i) => {
			if (i) out.push({ text: " " });
			const text = l[r] ?? "";
			if (ink.depth === 0) out.push({ text });
			else if (ink.depth === 16) out.push({ text, bold: true });
			else
				out.push({
					text,
					fg: { hex: stops[i] ?? "#F5DC9A", c256: c256[i] ?? 222 },
				});
		});
		return out;
	});
}

export interface ArrivalFrame {
	scales?: string[];
	gild?: number;
	ms: number;
}
/** §7.4: weighing (3 × 120 ms), then gilding (10 × 35 ms): 710 ms. */
export const ARRIVAL: ArrivalFrame[] = [
	{ scales: LEFT_HEAVY, ms: 120 },
	{ scales: RIGHT_HEAVY, ms: 120 },
	{ ms: 120 },
	...Array.from({ length: 10 }, (_, gild) => ({ gild, ms: 35 })),
];

/** The arrival frame at `elapsed` ms, or undefined once it has finished. */
export function arrivalAt(elapsed: number): ArrivalFrame | undefined {
	let t = 0;
	for (const f of ARRIVAL) {
		t += f.ms;
		if (elapsed < t) return f;
	}
	return undefined;
}
