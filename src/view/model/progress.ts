import { ms } from "./format";
import type { ChildView, RunView, WaveView } from "./types";

/** A run's or a wave's progress: what has landed of the whole, how long, what it cost. */
export interface Progress {
	/** Landed children; a closed child needs no more work, so it counts as done. */
	done: number;
	total: number;
	/** First row to now while a child runs, else to the last row; undefined before any row. */
	elapsedMs?: number;
	/** Whether the elapsed time is still counting. */
	live: boolean;
	tokens: number;
}

export const isDone = (c: ChildView) =>
	c.state === "landed" || c.state === "closed";

/** A quiet child has stalled: its run's clock stops at the last row until it speaks again. */
const running = (c: ChildView) => c.state === "running" && c.phase !== "quiet";

/** The children's progress over the time their rows cover. */
function progressOf(
	children: ChildView[],
	times: number[],
	now: number,
): Progress {
	const live = children.some(running);
	const at = times.filter((t) => !Number.isNaN(t));
	const first = at.length ? Math.min(...at) : undefined;
	const last = at.length ? Math.max(...at) : undefined;
	return {
		done: children.filter(isDone).length,
		total: children.length,
		elapsedMs:
			first === undefined ? undefined : (live ? now : (last ?? first)) - first,
		live,
		tokens: children.reduce((s, c) => s + c.tokens, 0),
	};
}

export const runProgress = (r: RunView, now: number): Progress =>
	progressOf(
		r.children,
		[ms(r.startedAt), ms(r.lastAt)].filter((t) => !Number.isNaN(t)),
		now,
	);

export function waveProgress(w: WaveView, now: number): Progress {
	const times = w.children.flatMap((c) =>
		c.attempts.flatMap((a) => a.events.map((e) => ms(e.at))),
	);
	return progressOf(w.children, times, now);
}
