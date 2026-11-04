import { sgr } from "../view/render/ink";
import { hero } from "../view/render/logo";
import type { Style } from "./style";

/** The Portia banner: the scales weighing the name, the pitch and the epigraph. */
export function banner(st: Style): string {
	const ink = {
		depth: st.colour ? 16 : 0,
		theme: "dark",
		unicode: st.unicode,
		motion: false,
	} as const;
	const lines = hero(ink, { finial: "idle", breath: 0 }).map((l) =>
		`  ${sgr(l, ink)}`.trimEnd(),
	);
	return `\n${lines.join("\n")}\n`;
}
