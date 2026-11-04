import type { RunRow } from "../../core/types";

export interface ParsedLog {
	rows: RunRow[];
	skipped: number;
	/** The last line when the text did not end in a newline: a write still in progress. */
	tail: string;
}

const isRow = (v: unknown): v is RunRow =>
	typeof v === "object" &&
	v !== null &&
	typeof (v as RunRow).at === "string" &&
	typeof (v as RunRow).child === "string" &&
	typeof (v as RunRow).stage === "string";

export function parseRunlog(text: string): ParsedLog {
	return appendRunlog({ rows: [], skipped: 0, tail: "" }, text);
}

/** Parses `prev.tail + chunk` the same way and appends the rows to `prev`'s. */
export function appendRunlog(prev: ParsedLog, chunk: string): ParsedLog {
	const lines = (prev.tail + chunk).split("\n");
	const tail = lines.pop() ?? "";
	const rows = [...prev.rows];
	let skipped = prev.skipped;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line);
			if (isRow(v)) rows.push({ ...v, attempt: Number(v.attempt) || 0 });
			else skipped++;
		} catch {
			skipped++;
		}
	}
	return { rows, skipped, tail };
}
