import { PortiaProblem } from "../core/exit";
import type { DesignRef } from "./types";

export function parseDesignRef(value: string): DesignRef {
	const [link = "", ...pairs] = value.trim().split(/\s+/);
	const kv = Object.fromEntries(
		pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]),
	);
	if (!link || !kv.route || !kv.persona || !kv.frames)
		throw new PortiaProblem(
			`design line needs a link, route=, persona= and frames=: '${value}'`,
		);
	return {
		link,
		route: kv.route,
		persona: kv.persona,
		frames: kv.frames.split(",").filter(Boolean),
	};
}
