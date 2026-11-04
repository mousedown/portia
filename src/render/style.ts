export interface Style {
	colour: boolean;
	unicode: boolean;
	width: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI = /\x1b\[[0-9;]*m/g;

export const plain = (width = 72): Style => ({
	colour: false,
	unicode: true,
	width,
});

/** The only impure function in src/render. */
export function detect(
	env: Record<string, string | undefined> = process.env,
	isTTY = Boolean(process.stdout.isTTY),
): Style {
	const cols = Number(env.COLUMNS ?? process.stdout.columns ?? 80);
	return {
		colour: isTTY && env.NO_COLOR === undefined,
		unicode: env.PORTIA_ASCII === undefined,
		width: Math.min(120, Math.max(56, Number.isFinite(cols) ? cols : 80)),
	};
}

export const widthOf = (s: string): number => [...s.replace(ANSI, "")].length;

/** Pads or cuts plain text to exactly w columns. Never call it on coloured text. */
export function fit(s: string, w: number, st: Style): string {
	const chars = [...s];
	if (chars.length <= w) return s + " ".repeat(w - chars.length);
	return chars.slice(0, Math.max(0, w - 1)).join("") + (st.unicode ? "…" : "~");
}

export const paint = (s: string, code: number, st: Style): string =>
	st.colour ? `\x1b[${code}m${s}\x1b[0m` : s;
