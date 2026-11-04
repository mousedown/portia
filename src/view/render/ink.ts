import type { Role } from "../model/types";
import type { Fg, Line, Span } from "./text";
import { asciify } from "./text";

export type Depth = 0 | 16 | 256 | 24;
export type Theme = "dark" | "light";
export interface Ink {
	depth: Depth;
	theme: Theme;
	unicode: boolean;
	motion: boolean;
	/** OSC 8 hyperlinks: only the live view sets it, so frames and snapshots stay plain. */
	links?: boolean;
}

type Entry = [
	dark: string,
	dark256: number,
	light: string,
	light256: number,
	c16: string,
];

/** §6.3: contrast computed against #1B1B1F (dark) and #FFFFFF (light). */
export const PALETTE: Record<Role | "selBg" | "track" | "bar", Entry> = {
	ink: ["#E8E4DC", 254, "#24211C", 235, ""],
	ink2: ["#ABA597", 248, "#5C574D", 240, ""],
	dim: ["#8C877C", 245, "#736D62", 242, "2"],
	faint: ["#5E5A52", 240, "#B3ADA2", 249, "2"],
	rule: ["#3A3731", 237, "#DDD7CC", 253, "2"],
	accent: ["#E6BF68", 179, "#8F6410", 94, "33"],
	accentBright: ["#F7DE9C", 222, "#6E4A0C", 94, "1;33"],
	// Reverse video at 16 colours: plain 33 is the accent, and 1;33 its bright form.
	warn: ["#F0A35E", 215, "#9C5A00", 130, "7;33"],
	selBg: ["#2A2620", 235, "#F2EBDC", 255, ""],
	// A progress bar's empty part: a soft solid track, quieter than any text.
	track: ["#38352F", 237, "#EBE6DC", 254, "2"],
	// A progress bar's fill: the accent's gold, never its dark text shade on light.
	bar: ["#E6BF68", 179, "#D6AA4E", 179, "33"],
	pending: ["#8C877C", 245, "#7A7468", 243, "2"],
	ready: ["#CFC9BC", 251, "#4F4A41", 239, ""],
	running: ["#7DB8F5", 111, "#1D68B8", 25, "36"],
	parked: ["#D3A0E6", 183, "#8A4BA8", 97, "35"],
	failed: ["#F0787A", 210, "#BE323B", 160, "31"],
	done: ["#6FCFB8", 79, "#127A65", 29, "32"],
	landed: ["#9AD47E", 114, "#3A7F24", 28, "1;32"],
	closed: ["#8C877C", 245, "#7A7468", 243, "2"],
	quiet: ["#8C877C", 245, "#736D62", 242, "2"],
};

export const hexOf = (
	role: Role | "selBg" | "track" | "bar",
	theme: Theme,
): string => {
	const e = PALETTE[role];
	return theme === "dark" ? e[0] : e[2];
};
export const fgOf = (role: Role | "track" | "bar", theme: Theme): Fg => {
	const e = PALETTE[role];
	return theme === "dark"
		? { hex: e[0], c256: e[1], c16: e[4] }
		: { hex: e[2], c256: e[3], c16: e[4] };
};

export const rgb = (hex: string): [number, number, number] => {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const lin = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export function luminance(hex: string): number {
	const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [
		number,
		number,
	];
	return (x + 0.05) / (y + 0.05);
}

type Lab = [number, number, number];
function toLab(hex: string): Lab {
	const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}
function fromLab([L, A, B]: Lab): string {
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	const out = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	].map((v) => {
		const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
		return Math.round(Math.min(1, Math.max(0, c)) * 255);
	});
	return `#${out
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase()}`;
}
/** a → b by t, in OKLab. */
export function mix(a: string, b: string, t: number): string {
	const p = toLab(a);
	const q = toLab(b);
	return fromLab([
		p[0] + (q[0] - p[0]) * t,
		p[1] + (q[1] - p[1]) * t,
		p[2] + (q[2] - p[2]) * t,
	]);
}

/** The same hue, its OKLab lightness scaled by `l` and its chroma by `c`. */
export function shade(hex: string, l: number, c = 1): string {
	const [L, A, B] = toLab(hex);
	return fromLab([L * l, A * c, B * c]);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: text from files must never carry escapes
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

function codes(span: Span, ink: Ink): string {
	const out: string[] = [];
	const theme = ink.theme;
	const fg = span.fg ?? (span.role ? fgOf(span.role, theme) : undefined);
	if (span.bold) out.push("1");
	if (span.italic) out.push("3");
	if (span.underline) out.push("4");
	if (span.strike) out.push("9");
	if (span.reverse) out.push("7");
	if (ink.depth === 24) {
		if (fg) out.push(`38;2;${rgb(fg.hex).join(";")}`);
		if (span.bg) out.push(`48;2;${rgb(span.bg.hex).join(";")}`);
		else if (span.sel) out.push(`48;2;${rgb(hexOf("selBg", theme)).join(";")}`);
	} else if (ink.depth === 256) {
		if (fg) out.push(`38;5;${fg.c256}`);
		if (span.bg) out.push(`48;5;${span.bg.c256}`);
		else if (span.sel)
			out.push(`48;5;${PALETTE.selBg[theme === "dark" ? 1 : 3]}`);
	} else if (fg?.c16) out.push(fg.c16);
	return out.join(";");
}

/** OSC 8: opens a hyperlink, or closes one with an empty URL. */
export const osc8 = (url = "") => `\x1b]8;;${url.replace(CONTROL, "")}\x1b\\`;

/**
 * Paints a line. Runs of one style are coalesced; depth 0 emits no colour escape at
 * all. With `ink.links`, a span's link wraps its text in OSC 8, so the terminal opens it.
 */
export function sgr(line: Line, ink: Ink): string {
	const text = (s: Span) => {
		const t = s.text.replace(CONTROL, " ").replaceAll("\ufe0f", "");
		return ink.unicode ? t : asciify(t);
	};
	let out = "";
	let cur = "";
	let link: string | undefined;
	for (const span of line) {
		if (!span.text) continue;
		const want = ink.links ? span.link : undefined;
		if (want !== link) {
			out += osc8(want);
			link = want;
		}
		if (ink.depth !== 0) {
			const c = codes(span, ink);
			if (c !== cur) {
				out += c ? `\x1b[0;${c}m` : "\x1b[0m";
				cur = c;
			}
		}
		out += text(span);
	}
	if (link) out += osc8();
	return ink.depth === 0 ? out : `${out}\x1b[0m`;
}

export function parseOsc11(reply: string): string | undefined {
	const m = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(
		reply,
	);
	if (!m) return undefined;
	const ch = (h = "0") =>
		Math.round((Number.parseInt(h, 16) / (16 ** h.length - 1)) * 255);
	return `#${[m[1], m[2], m[3]].map((h) => ch(h).toString(16).padStart(2, "0")).join("")}`;
}

/** §6.2. The only inputs are the environment, whether stdout is a TTY and the OSC 11 reply. */
export function detectInk(
	env: Record<string, string | undefined>,
	isTTY: boolean,
	bgReply?: string,
	flags: {
		depth?: Depth;
		theme?: Theme;
		ascii?: boolean;
		noMotion?: boolean;
	} = {},
): Ink {
	let depth: Depth =
		env.NO_COLOR !== undefined || !isTTY || env.TERM === "dumb"
			? 0
			: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit"
				? 24
				: (env.TERM ?? "").includes("256color")
					? 256
					: 16;
	if (flags.depth !== undefined) depth = flags.depth;
	let theme: Theme = "dark";
	const forced = flags.theme ?? env.PORTIA_THEME;
	const bg = bgReply ? parseOsc11(bgReply) : undefined;
	const fgbg = env.COLORFGBG?.split(";").at(-1);
	if (forced === "dark" || forced === "light") theme = forced;
	else if (bg) theme = luminance(bg) < 0.4 ? "dark" : "light";
	else if (fgbg !== undefined && fgbg !== "")
		theme = /^([0-6]|8)$/.test(fgbg) ? "dark" : "light";
	return {
		depth,
		theme,
		unicode: !(flags.ascii || env.PORTIA_ASCII !== undefined),
		motion: !(
			flags.noMotion ||
			env.PORTIA_REDUCED_MOTION !== undefined ||
			depth === 0
		),
	};
}
