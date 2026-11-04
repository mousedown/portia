import type { ChildState, RunRow } from "../../core/types";
import { ms } from "./format";
import type { Phase } from "./types";

export const QUIET_MS = 45 * 60_000;

/**
 * Gate rows are written after a gate finishes, so the step running now is never on
 * disk: the phase is inferred from the newest row after the dispatch.
 */
export function phaseOf(
	rows: RunRow[],
	state: ChildState,
	now: number,
): { phase: Phase; since: string; raw: Phase } | undefined {
	if (state === "done") {
		const r = rows.filter((x) => x.stage === "result").at(-1);
		return r ? { phase: "landing", since: r.at, raw: "landing" } : undefined;
	}
	if (state !== "running") return undefined;
	const d = rows.map((r) => r.stage).lastIndexOf("dispatched");
	const dispatched = rows[d];
	if (!dispatched) return undefined;
	const after = rows.slice(d + 1).filter((r) => r.stage !== "env");
	const last = after.at(-1);
	let phase: Phase = "working";
	let since = dispatched.at;
	if (last?.stage === "gate") {
		const pass = last.status === "pass";
		phase =
			last.data?.kind === "task"
				? pass
					? "exit gate"
					: "fixing"
				: pass
					? "reporting"
					: "fixing";
		since = last.at;
	} else if (last) since = last.at;
	const newest = rows.at(-1) ?? dispatched;
	if (now - ms(newest.at) >= QUIET_MS)
		return { phase: "quiet", since: newest.at, raw: phase };
	return { phase, since, raw: phase };
}
