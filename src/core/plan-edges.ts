/** What drawing a run's shape needs of a child, from the plan or from the view. */
export interface EdgeChild {
	key: string;
	wave: number;
	needs?: { key: string }[];
}

/**
 * Which children each child waits on, inside this run: its needs, else the spine. A need
 * another need already waits on adds no line: 503 needing the spine and 502, which needs
 * the spine too, draws only 502 ──▶ 503.
 */
export function waitEdges(children: EdgeChild[]): Map<string, string[]> {
	const inRun = new Set(children.map((c) => c.key));
	const spine = children.filter((c) => c.wave === 0).map((c) => c.key);
	const out = new Map<string, string[]>();
	for (const c of children) {
		const named = (c.needs ?? [])
			.map((n) => n.key)
			.filter((k) => inRun.has(k) && k !== c.key);
		out.set(c.key, named.length || c.wave === 0 ? named : spine);
	}
	const reach = (from: string, seen = new Set<string>()): Set<string> => {
		for (const k of out.get(from) ?? [])
			if (!seen.has(k)) {
				seen.add(k);
				reach(k, seen);
			}
		return seen;
	};
	for (const [key, needs] of out)
		out.set(
			key,
			needs.filter((k) => !needs.some((o) => o !== k && reach(o).has(k))),
		);
	return out;
}
