import { regionMarks } from "../../ledger/render";
import type { LedgerRow, LedgerView } from "./types";

// Cells split on pipes that are not escaped: a summary may hold "CSV \| XLSX".
const cells = (line: string): string[] =>
	line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((c) => c.trim().replace(/\\\|/g, "|"));

/** Reads the ledger table and its evidence between the markers, and nothing else. */
export function parseLedger(
	md: string,
): Omit<LedgerView, "mtimeMs"> | undefined {
	const marks = regionMarks(md);
	if (!marks) return undefined;
	const s = md.indexOf(marks.start);
	const e = md.indexOf(marks.end, s + marks.start.length);
	if (e < 0) return undefined;
	const region = md.slice(s + marks.start.length, e);
	const rows: LedgerRow[] = [];
	const evidence: LedgerView["evidence"] = [];
	for (const line of region.split("\n")) {
		if (line.startsWith("| ")) {
			const [
				wave = "",
				child = "",
				state = "",
				pr = "",
				req = "",
				touches = "",
				design = "",
				model = "",
			] = cells(line);
			if (!/^\d+$/.test(wave)) continue;
			const space = child.indexOf(" ");
			const prMatch = /#(\d+)/.exec(pr);
			rows.push({
				wave: Number(wave),
				key: space < 0 ? child : child.slice(0, space),
				summary: space < 0 ? "" : child.slice(space + 1).trim(),
				state,
				pr: prMatch ? Number(prMatch[1]) : undefined,
				requirements: [...req.matchAll(/([A-Za-z0-9_-]+)\s*(✓|✗)/g)].map(
					(m) => ({ id: m[1] ?? "", ok: m[2] === "✓" }),
				),
				touches: /outside touches/.test(touches)
					? "outside"
					: touches === "matched"
						? "matched"
						: undefined,
				design: design.replace(/\*\*/g, ""),
				model,
			});
			continue;
		}
		const ev = /^- (\S+) ([A-Za-z0-9_-]+): (.*)$/.exec(line);
		if (ev)
			evidence.push({ key: ev[1] ?? "", id: ev[2] ?? "", text: ev[3] ?? "" });
	}
	return { rows, evidence };
}
