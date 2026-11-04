import { childKeyOf, integrationBranch } from "../core/branches";
import type { Profile } from "../core/config";
import { type Exec, must } from "../core/exec";
import { appendRow, readRows } from "../core/runlog";
import { DECIDING, deriveStates, scheduleOf, waveGateDue } from "../core/state";
import type { ParentPlan, RunRow } from "../core/types";
import { landRunning, transitionLanded } from "../land/land";
import type { Tracker } from "../plan/tracker";
import { questionsWaiting } from "../questions/questions";

export type ResumeAction = {
	child: string;
	action:
		| "record-landed"
		| "redispatch"
		| "await-answer"
		| "decide-failure"
		| "land"
		| "await-land"
		| "await-worker"
		| "answer-questions"
		| "wave-gate";
	detail: string;
};

interface Merged {
	headRefName: string;
	number: number;
	mergeCommit: { oid: string } | null;
}

const lastAttempt = (rows: RunRow[], child: string): number =>
	rows.filter((r) => r.child === child && r.stage === "dispatched").at(-1)
		?.attempt ?? 0;

/** Whether the child's last landed row left its ticket unmoved: pending, or its last tracker row failed. */
function trackerDue(rows: RunRow[], child: string): boolean {
	const mine = rows.filter((r) => r.child === child);
	const landed = mine.filter((r) => r.stage === "landed").at(-1);
	if (landed?.data?.tracker !== "pending") return false;
	return (
		mine
			.slice(mine.indexOf(landed))
			.filter((r) => r.stage === "tracker")
			.at(-1)?.status !== "transitioned"
	);
}

/**
 * Rebuilds run state from GitHub, git worktrees and the run log. GitHub wins for
 * landings and records any it has that the log lost, and retries a landed transition a
 * land never finished. It never lands, dispatches or merges; it returns the actions
 * SKILL.md takes next.
 */
export async function resume(
	plan: ParentPlan,
	ctx: {
		exec: Exec;
		profile: Profile;
		repoRoot: string;
		dir: string;
		tracker?: Pick<Tracker, "transition">;
		landedTransition?: string;
		/** Detached workers still running, by child: they are waited on, not redispatched. */
		alive?: Record<string, string>;
	},
): Promise<{ actions: ResumeAction[]; problems: string[] }> {
	const base = integrationBranch(ctx.profile, plan.key);
	const listed = await must(
		ctx.exec,
		"gh",
		[
			"pr",
			"list",
			"--base",
			base,
			"--state",
			"merged",
			"--limit",
			"200",
			"--json",
			"headRefName,number,mergeCommit",
		],
		{ cwd: ctx.repoRoot },
	);
	const mergedList = JSON.parse(listed || "[]") as Merged[];
	const mergedNumbers = new Set(mergedList.map((m) => m.number));
	const merged = new Map(
		mergedList.map((m) => [
			childKeyOf(ctx.profile, m.headRefName) ?? m.headRefName,
			m,
		]),
	);
	const worktrees = new Set(
		(
			await must(ctx.exec, "git", ["worktree", "list", "--porcelain"], {
				cwd: ctx.repoRoot,
			})
		)
			.split("\n")
			.filter((l) =>
				l.startsWith(`branch refs/heads/${ctx.profile.branchPrefix}/`),
			)
			.map((l) =>
				l.slice(`branch refs/heads/${ctx.profile.branchPrefix}/`.length),
			),
	);

	/** Whether `sha` is on origin's integration branch; fetched once, only when it is not yet. */
	let fetched = false;
	const onBranch = async (sha: string): Promise<boolean> => {
		const check = async () =>
			(
				await ctx.exec(
					"git",
					["merge-base", "--is-ancestor", sha, `origin/${base}`],
					{ cwd: ctx.repoRoot },
				)
			).code === 0;
		if (await check()) return true;
		if (fetched) return false;
		fetched = true;
		await ctx.exec("git", ["fetch", "origin", base], { cwd: ctx.repoRoot });
		return check();
	};
	const actions: ResumeAction[] = [];
	const problems: string[] = [];
	const tracking = Boolean(ctx.tracker && ctx.landedTransition);
	let rows = readRows(ctx.dir).rows;
	for (const c of plan.children) {
		const m = merged.get(c.key);
		// A land still running records its own merge; recording it here too would log it twice.
		// Check it first, then read the log afresh: a land that finished since an earlier
		// read has logged its merge already.
		const running =
			m !== undefined && landRunning(ctx.dir, c.key) !== undefined;
		if (m && !running) rows = readRows(ctx.dir).rows;
		const landedRow = rows
			.filter((r) => r.child === c.key && r.stage === "landed")
			.at(-1);
		const logged = landedRow !== undefined;
		// A child landed from a PR that built several children (`land --merged-in`) has no
		// merged PR from its own branch; the PR its row names is merged instead.
		const viaPr =
			typeof landedRow?.data?.pr === "number" &&
			mergedNumbers.has(landedRow.data.pr);
		if (m && !logged && !running) {
			// The crash may have fallen between merge and the tracker transition, so the
			// transition is left pending for the retry below, bounded like a land's.
			appendRow(ctx.dir, {
				child: c.key,
				attempt: lastAttempt(rows, c.key),
				stage: "landed",
				status: "landed",
				data: {
					pr: m.number,
					sha: m.mergeCommit?.oid,
					source: "resume",
					...(tracking ? { tracker: "pending" } : {}),
				},
			});
			actions.push({
				child: c.key,
				action: "record-landed",
				detail: `PR #${m.number} merged into ${base}`,
			});
		} else if (!m && logged && !viaPr) {
			// A direct landing (`directLand`) has no PR: its commit on the integration branch is the record.
			const sha =
				landedRow?.data?.direct === true &&
				typeof landedRow.data.sha === "string"
					? landedRow.data.sha
					: undefined;
			if (sha && (await onBranch(sha))) continue;
			problems.push(
				sha
					? `${c.key}: the run log says landed directly as ${sha}, but that commit is not on ${base}`
					: `${c.key}: the run log says landed, but GitHub has no merged PR into ${base}`,
			);
		}
	}

	// A land writes its landed row before it moves the ticket; one killed in between left
	// the transition pending, and one whose tracker hung or failed left a failed `tracker`
	// row. Either is tried again until a transition succeeds.
	if (ctx.tracker && ctx.landedTransition) {
		for (const c of plan.children) {
			// Lock first, then a fresh read: a land that finished meanwhile has written its own tracker row.
			if (landRunning(ctx.dir, c.key)) continue;
			rows = readRows(ctx.dir).rows;
			if (trackerDue(rows, c.key))
				await transitionLanded(
					ctx.dir,
					ctx.tracker,
					c.key,
					ctx.landedTransition,
				);
		}
	}

	rows = readRows(ctx.dir).rows;
	const waveGated = ctx.profile.waveGate !== undefined;
	const states = deriveStates(plan, rows, scheduleOf(ctx.profile));
	for (const c of plan.children) {
		const attempt = lastAttempt(rows, c.key);
		const state = states.get(c.key);
		const landing = landRunning(ctx.dir, c.key);
		if (landing && state !== "landed" && state !== "closed") {
			actions.push({
				child: c.key,
				action: "await-land",
				detail: `portia land is still running for it (pid ${landing})`,
			});
			continue;
		}
		switch (state) {
			case "running":
				if (ctx.alive?.[c.key]) {
					actions.push({
						child: c.key,
						action: "await-worker",
						detail: `attempt ${attempt} runs detached: ${ctx.alive[c.key]}`,
					});
					break;
				}
				actions.push({
					child: c.key,
					action: "redispatch",
					detail: worktrees.has(c.key)
						? `no result for attempt ${attempt}; a fresh worker resumes in its worktree`
						: `no result for attempt ${attempt} and no worktree; run portia env up first`,
				});
				break;
			case "parked":
				actions.push({
					child: c.key,
					action: "await-answer",
					detail: "parked; waiting on a person",
				});
				break;
			case "failed": {
				const last = rows
					.filter((r) => r.child === c.key && DECIDING.has(r.stage))
					.at(-1);
				actions.push(
					last?.stage === "land" && last.data?.infra === true
						? {
								child: c.key,
								action: "land",
								detail: "CI or GitHub failed its last landing, not the child",
							}
						: {
								child: c.key,
								action: "decide-failure",
								detail: "failed; ask portia decide failure",
							},
				);
				break;
			}
			case "done":
				actions.push({
					child: c.key,
					action: "land",
					detail: "done but not landed",
				});
				break;
		}
	}
	const due = waveGated ? waveGateDue(plan, rows) : undefined;
	if (due !== undefined)
		actions.push({
			child: plan.key,
			action: "wave-gate",
			detail: `wave ${due} has landed; its wave gate runs before the next wave`,
		});
	const waiting = questionsWaiting(ctx.profile.askOnce, ctx.dir, plan.key);
	if (waiting)
		actions.unshift({
			child: plan.key,
			action: "answer-questions",
			detail: waiting,
		});
	return { actions, problems };
}
