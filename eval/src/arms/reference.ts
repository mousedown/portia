import { git, gitOk } from "../metrics/git";
import type { Arm } from ".";

/**
 * The ceiling: a reference implementation kept on `reference/<KEY>` in the repo, written by
 * a person and never merged. Every hidden scenario must pass against it, which is how a
 * suite proves its specs are satisfiable before any arm is judged by them.
 */
export const reference: Arm = {
	name: "reference",
	description:
		"Checks out reference/<KEY>: the hand-written solution every hidden spec must pass against.",
	free: true,
	async run(ctx) {
		const branch = `reference/${ctx.epic.key}`;
		if (
			!(await gitOk(ctx.clone, ["rev-parse", "--verify", `origin/${branch}`]))
		)
			throw new Error(`no ${branch} in ${ctx.repo.name}`);
		await git(ctx.clone, ["checkout", "-q", "-b", branch, `origin/${branch}`]);
		return {
			exitCode: 0,
			branch,
			branchesToMerge: 1,
			partial: {
				cost: {
					tokens: 0,
					tokensByModel: {},
					usd: 0,
					wallMinutes: 0,
					workMinutes: 0,
				},
				human: { decisions: 0, waitingMinutes: 0 },
			},
		};
	},
};
