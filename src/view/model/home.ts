import { join } from "node:path";
import { ms } from "./format";
import type { ViewFs } from "./fs";
import { buildRun, gatherRun } from "./run";
import type { Group, HomeView, RunView, Sort } from "./types";

/** A run waiting on the person's answer comes first, so it is seen without opening it. */
export const GROUPS: Group[] = [
	"waiting",
	"session",
	"judgement",
	"rest",
	"delivered",
];
const WEEK = 7 * 86_400_000;

const activity = (r: RunView) => (r.lastAt ? ms(r.lastAt) : (r.mtimeMs ?? 0));

/** Groups in their fixed order; inside a group, by the chosen sort. */
export function sortRuns(runs: RunView[], sort: Sort = "activity"): RunView[] {
	const cmp = (a: RunView, b: RunView) =>
		sort === "key"
			? a.key.localeCompare(b.key, undefined, { numeric: true })
			: sort === "tokens"
				? b.tokens - a.tokens || a.key.localeCompare(b.key)
				: activity(b) - activity(a) || a.key.localeCompare(b.key);
	return [...runs].sort(
		(a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || cmp(a, b),
	);
}

export function homeOf(
	home: string,
	runs: RunView[],
	now: number,
	sort: Sort = "activity",
): HomeView {
	const sorted = sortRuns(runs, sort);
	return {
		home,
		runs: sorted,
		inSession: runs.filter((r) => r.group === "session").length,
		needYou: runs.filter(
			(r) => r.group === "waiting" || r.group === "judgement",
		).length,
		runningChildren: runs.reduce(
			(s, r) =>
				s +
				r.children.filter((c) => c.state === "running" && c.phase !== "quiet")
					.length,
			0,
		),
		landedThisWeek: runs.reduce(
			(s, r) =>
				s +
				r.events.filter(
					(e) => e.row.stage === "landed" && now - ms(e.at) < WEEK,
				).length,
			0,
		),
		tokens: runs.reduce((s, r) => s + r.tokens, 0),
	};
}

/** Every directory under runs/ is a run, whatever it holds. */
export function runKeys(fs: ViewFs, home: string): string[] {
	const dir = join(home, "runs");
	return fs
		.list(dir)
		.filter((n) => !n.startsWith(".") && fs.stat(join(dir, n))?.dir);
}

export function readHome(
	fs: ViewFs,
	home: string,
	now: number,
	sort: Sort = "activity",
): HomeView {
	const runs = runKeys(fs, home).map((k) =>
		buildRun(gatherRun(fs, home, k), now),
	);
	return homeOf(home, runs, now, sort);
}
