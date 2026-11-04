import { git, gitOk } from "../metrics/git";
import type { Arm, ArmContext, ArmOutcome } from ".";
import { epicBrief, reviewedSession, savedReviewedSession } from "./claude";

/** One Claude Code session, the whole epic, one branch. The simplest honest baseline. */
export const claudeSerial: Arm = {
	name: "claude-serial",
	description:
		"One Claude Code session is given the epic and its scenarios and told to deliver it on a branch, then sent back while the repo's checks fail.",
	run: (ctx) => oneBranch(ctx, "claude-serial", epicBrief(ctx)),
	rebuild: (ctx) => savedOneBranch(ctx, "claude-serial"),
};

/** One reviewed session on `eval/<KEY>/<arm>`: the shape both single-session baselines share. */
export async function oneBranch(
	ctx: ArmContext,
	arm: string,
	prompt: string,
): Promise<ArmOutcome> {
	const branch = `eval/${ctx.epic.key}/${arm}`;
	await git(ctx.clone, ["checkout", "-b", branch]);
	return oneBranchOutcome(
		branch,
		await reviewedSession(ctx, { cwd: ctx.clone, prompt, name: "session" }),
	);
}

/** `oneBranch`'s outcome from the branch it left and its saved transcripts (`session*.json`). */
export async function savedOneBranch(
	ctx: ArmContext,
	arm: string,
): Promise<ArmOutcome> {
	const branch = `eval/${ctx.epic.key}/${arm}`;
	if (!(await gitOk(ctx.clone, ["rev-parse", "--verify", "--quiet", branch])))
		throw new Error(`no ${branch} in ${ctx.clone}: nothing to rebuild`);
	const saved = savedReviewedSession(
		ctx.artifacts,
		"session",
		ctx.limits.minutes,
	);
	if (!saved)
		throw new Error(`no session.json in ${ctx.artifacts}: nothing to rebuild`);
	return oneBranchOutcome(branch, saved);
}

function oneBranchOutcome(
	branch: string,
	{
		session: s,
		rework,
		decisions,
	}: Awaited<ReturnType<typeof reviewedSession>>,
): ArmOutcome {
	return {
		exitCode: s.exitCode,
		stoppedBy: s.stoppedBy,
		branch,
		branchesToMerge: 1,
		partial: {
			cost: {
				tokens: s.tokens,
				tokensByModel: s.tokensByModel,
				usd: s.usd,
				wallMinutes: s.minutes,
				workMinutes: s.minutes,
			},
			rework,
			human: { decisions, waitingMinutes: 0 },
		},
	};
}
