export interface Key {
	/** up down left right home end pgup pgdn enter esc backspace tab stab char paste osc ^a…^z */
	name: string;
	ch?: string;
	text?: string;
}

const CSI: Record<string, string> = {
	A: "up",
	B: "down",
	C: "right",
	D: "left",
	H: "home",
	F: "end",
	Z: "stab",
};
const TILDE: Record<string, string> = {
	"1": "home",
	"7": "home",
	"4": "end",
	"8": "end",
	"5": "pgup",
	"6": "pgdn",
	"3": "delete",
};
const PASTE_END = "\x1b[201~";

/**
 * Decodes input into keys. Whatever is left at the end (a lone ESC, or a sequence cut
 * short) is returned as `rest`: the caller waits 25 ms for more, then sends a lone ESC
 * back through as `esc`.
 */
export function decode(input: string): { keys: Key[]; rest: string } {
	const keys: Key[] = [];
	let i = 0;
	while (i < input.length) {
		const c = input[i] ?? "";
		if (c === "\x1b") {
			const next = input[i + 1];
			if (next === undefined) return { keys, rest: input.slice(i) };
			if (next === "[" || next === "O") {
				if (input.startsWith("\x1b[200~", i)) {
					const end = input.indexOf(PASTE_END, i + 6);
					if (end < 0) return { keys, rest: input.slice(i) };
					keys.push({ name: "paste", text: input.slice(i + 6, end) });
					i = end + PASTE_END.length;
					continue;
				}
				// biome-ignore lint/suspicious/noControlCharactersInRegex: decoding escapes
				const m = /^\x1b[[O]([0-9;]*)([A-Za-z~])/.exec(input.slice(i));
				if (!m) {
					// biome-ignore lint/suspicious/noControlCharactersInRegex: decoding escapes
					if (/^\x1b[[O][0-9;]*$/.test(input.slice(i)))
						return { keys, rest: input.slice(i) };
					keys.push({ name: "esc" });
					i++;
					continue;
				}
				const [all, params = "", fin = ""] = m;
				const name = fin === "~" ? TILDE[params.split(";")[0] ?? ""] : CSI[fin];
				if (name) keys.push({ name });
				i += all.length;
				continue;
			}
			if (next === "]") {
				// An OSC reply, ended by BEL or ST.
				const bel = input.indexOf("\x07", i);
				const st = input.indexOf("\x1b\\", i);
				const ends = [bel, st].filter((x) => x >= 0);
				if (!ends.length) return { keys, rest: input.slice(i) };
				const end = Math.min(...ends);
				keys.push({ name: "osc", text: input.slice(i + 2, end) });
				i = end + (end === st ? 2 : 1);
				continue;
			}
			// Alt+key, or ESC typed then a key: ESC, and the key on its own.
			keys.push({ name: "esc" });
			i++;
			continue;
		}
		if (c === "\r" || c === "\n") keys.push({ name: "enter" });
		else if (c === "\x7f" || c === "\b") keys.push({ name: "backspace" });
		else if (c === "\t") keys.push({ name: "tab" });
		else if (c < " ")
			keys.push({ name: `^${String.fromCharCode(c.charCodeAt(0) + 96)}` });
		else {
			const cp = input.codePointAt(i) ?? 0;
			const ch = String.fromCodePoint(cp);
			keys.push({ name: "char", ch });
			i += ch.length;
			continue;
		}
		if (c === "\r" && input[i + 1] === "\n") i++;
		i++;
	}
	return { keys, rest: "" };
}
