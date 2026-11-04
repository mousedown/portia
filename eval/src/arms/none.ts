import { git } from "../metrics/git";
import type { Arm } from ".";

/**
 * The control: nothing is done to the repo. Every hidden scenario must fail against it,
 * which is how a new suite proves its specs are red, and it exercises the whole pipeline
 * without an agent.
 */
export const none: Arm = {
	name: "none",
	description:
		"Changes nothing: the control that every hidden spec must fail against.",
	free: true,
	async run(ctx) {
		const branch = `eval/${ctx.epic.key}/none`;
		await git(ctx.clone, ["checkout", "-b", branch]);
		return {
			exitCode: 0,
			branch,
			branchesToMerge: 0,
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
