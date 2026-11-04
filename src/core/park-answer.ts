import { PortiaProblem } from "./exit";
import { answerable, waitOf } from "./park";
import { appendRow, readRows } from "./runlog";
import { DECIDING } from "./state";
import type { RunRow } from "./types";

/**
 * Records the person's answer to a parked child. `onlyWaitingSince` is for a caller that
 * showed a question and may be late: it refuses unless that same question still waits.
 */
export function recordParkAnswer(
	dir: string,
	key: string,
	answer: string,
	o: { onlyWaitingSince?: string } = {},
): void {
	const rows = readRows(dir).rows.filter((r) => r.child === key);
	if (o.onlyWaitingSince !== undefined) {
		const w = waitOf(rows);
		if (w?.kind !== "question" || w.at !== o.onlyWaitingSince)
			throw new PortiaProblem(`${key} is no longer waiting on this question`);
		if (w.claim)
			throw new PortiaProblem(
				`${key}'s park is a spec claim, settled by amendment from the session`,
			);
	}
	const wait = answerable(rows);
	if (!wait)
		throw new PortiaProblem(
			`${key} is not parked on a question, nor a park or failure put to a person`,
		);
	const text = answer.trim();
	if (!text) throw new PortiaProblem(`the answer for ${key} is empty`);
	appendRow(dir, {
		child: key,
		attempt: wait.attempt,
		stage: "decision",
		status: "answer",
		data: { kind: "parked", by: "person", answer: text, why: wait.text },
	});
}

/** Children with an answer recorded after `since` that no dispatch or landing has acted on. */
export function answeredSince(rows: RunRow[], since = ""): string[] {
	const out: string[] = [];
	for (const key of new Set(rows.map((r) => r.child))) {
		const own = rows.filter((r) => r.child === key);
		const last = own.filter((r) => DECIDING.has(r.stage)).at(-1);
		if (!last || (last.stage !== "result" && last.stage !== "land")) continue;
		const answered = own.some(
			(r) =>
				r.stage === "decision" &&
				r.status === "answer" &&
				r.data?.kind === "parked" &&
				r.at >= last.at &&
				r.at > since,
		);
		if (answered) out.push(key);
	}
	return out;
}
