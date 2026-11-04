import { DECIDING } from "./state";
import type { RunRow } from "./types";

/**
 * What a parked child waits on: the person (a worker's question, a land or a failure put
 * to them), or a usage limit the run clears itself once an account frees.
 */
export type Wait =
	| {
			kind: "question";
			text: string;
			at: string;
			attempt: number;
			/** The park is a claim that a spec cannot pass: amendment settles it, not an answer. */
			claim?: true;
	  }
	| {
			kind: "limit";
			text: string;
			at: string;
			attempt: number;
			/** When the soonest account frees, as the decision named it. */
			frees?: string;
	  };

const LIMITED = /^every account is at its usage limit/;
const FREES = /the soonest frees at (\S+?)\.?(?:\s|$)/;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * What one child is waiting on, from its own rows in log order; undefined when nothing
 * waits. A park ends with the next dispatch or landing, or with an answer recorded after it.
 */
export function waitOf(rows: RunRow[]): Wait | undefined {
	const last = rows.filter((r) => DECIDING.has(r.stage)).at(-1);
	if (!last || (last.stage !== "result" && last.stage !== "land"))
		return undefined;
	const after = rows.filter((r) => r.stage === "decision" && r.at >= last.at);
	const answered = after.some(
		(r) =>
			r.data?.kind === "parked" ||
			(r.data?.kind === "park-answerable" && r.status === "answered"),
	);
	if (answered) return undefined;
	const text = str(
		last.stage === "result" ? last.data?.message : last.data?.reason,
	).trim();
	if (last.status === "parked")
		return {
			kind: "question",
			text,
			at: last.at,
			attempt: last.attempt,
			...(last.stage === "result" && last.data?.spec ? { claim: true } : {}),
		};
	if (last.status !== "failed") return undefined;
	const parked = after
		.filter((r) => r.data?.kind === "failure" && r.status === "park")
		.at(-1);
	if (!parked) return undefined;
	const why = str(parked.data?.why);
	if (LIMITED.test(why))
		return {
			kind: "limit",
			text: why,
			at: parked.at,
			attempt: last.attempt,
			frees: FREES.exec(why)?.[1],
		};
	return {
		kind: "question",
		text: [text, why].filter(Boolean).join("\n\n"),
		at: parked.at,
		attempt: last.attempt,
	};
}

/** Whether a failure decided as park waits on the person, not on a usage limit. */
export const parkNeedsPerson = (why: string) => !LIMITED.test(why);

/**
 * What a person's answer to a child would answer: the child's question when it waits on
 * one, else a park the run already answered, or a failure decided as park, or anything
 * decided `ask-human`, since its last result or land. A new answer replaces any earlier one, so
 * an answer is recordable wherever drive stops for one. Undefined when nothing asks.
 */
export function answerable(
	rows: RunRow[],
): { text: string; attempt: number } | undefined {
	const wait = waitOf(rows);
	if (wait) return wait.kind === "question" ? wait : undefined;
	const last = rows.filter((r) => DECIDING.has(r.stage)).at(-1);
	if (!last || (last.stage !== "result" && last.stage !== "land"))
		return undefined;
	const asked = rows.some(
		(r) =>
			r.stage === "decision" &&
			r.at >= last.at &&
			(r.status === "ask-human" ||
				(r.data?.kind === "failure" &&
					r.status === "park" &&
					parkNeedsPerson(str(r.data?.why)))),
	);
	if (last.status !== "parked" && !asked) return undefined;
	return {
		text: str(
			last.stage === "result" ? last.data?.message : last.data?.reason,
		).trim(),
		attempt: last.attempt,
	};
}
