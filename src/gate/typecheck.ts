const LINE = /^(.+?)\(\d+,\d+\): error TS\d+/;

export function parseTsc(output: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const l of output.split("\n")) {
		const m = LINE.exec(l.trim());
		if (m?.[1]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
	}
	return counts;
}

export function newTypeErrors(
	baseline: Map<string, number>,
	current: Map<string, number>,
	touched: string[],
): string[] {
	return touched.flatMap((f) => {
		const added = (current.get(f) ?? 0) - (baseline.get(f) ?? 0);
		return added > 0 ? [`${f}: ${added} new error(s)`] : [];
	});
}
