import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, gitOk } from "../metrics/git";
import type { Arm, ArmContext } from ".";
import { childTicket, claudeSession, ticket } from "./claude";

/**
 * The workspace and multiplexer shape without the GUI: one Claude Code session per ticket,
 * all at once, each in its own worktree, merged by a script in ticket order. Conflicts are
 * counted, not resolved: a conflicting branch is skipped, as a person would have to step in.
 */
export const claudeParallel: Arm = {
	name: "claude-parallel",
	description:
		"One Claude Code session per ticket, started at once in separate worktrees, merged by a script in ticket order.",
	async run(ctx) {
		const kids = ctx.epic.children;
		if (!kids.length)
			throw new Error(`${ctx.epic.key} has no children to run in parallel`);
		const branch = `eval/${ctx.epic.key}/claude-parallel`;
		await git(ctx.clone, ["checkout", "-b", branch]);
		const started = new Date();
		const sessions = await Promise.all(
			kids.map(async (kid) => {
				const wt = join(ctx.artifacts, "worktrees", kid.key);
				mkdirSync(join(ctx.artifacts, "worktrees"), { recursive: true });
				// Beside the arm's branch, not under it: git cannot hold both `x` and `x/y`.
				const kb = `${branch}-${kid.key}`;
				await git(ctx.clone, ["worktree", "add", "-b", kb, wt, branch]);
				const s = await claudeSession(ctx, {
					cwd: wt,
					prompt: childBrief(ctx, kid.key, kid.touches),
					name: `session-${kid.key}`,
					// The run's cap, shared between sessions that run at once.
					usd:
						ctx.limits.usd !== undefined
							? ctx.limits.usd / kids.length
							: undefined,
				});
				return { kid, kb, s };
			}),
		);
		// Merge in ticket order. A conflict is counted and the branch left out.
		let conflicts = 0;
		const merged: string[] = [];
		for (const { kid, kb } of sessions) {
			const ok = await gitOk(ctx.clone, [
				"merge",
				"--no-ff",
				"-m",
				`merge ${kid.key}`,
				kb,
			]);
			if (ok) merged.push(kb);
			else {
				conflicts++;
				await gitOk(ctx.clone, ["merge", "--abort"]);
				ctx.log(`${kid.key}: merge conflict, left out`);
			}
		}
		const tokensByModel: Record<string, number> = {};
		for (const { s } of sessions)
			for (const [m, n] of Object.entries(s.tokensByModel))
				tokensByModel[m] = (tokensByModel[m] ?? 0) + n;
		const usd = sessions.every((x) => x.s.usd !== undefined)
			? sessions.reduce((a, x) => a + (x.s.usd ?? 0), 0)
			: undefined;
		return {
			exitCode: sessions.some((x) => x.s.exitCode) ? 1 : 0,
			stoppedBy: sessions.find((x) => x.s.stoppedBy)?.s.stoppedBy,
			branch,
			branchesToMerge: kids.length,
			childBranches: merged,
			partial: {
				cost: {
					tokens: sessions.reduce((a, x) => a + x.s.tokens, 0),
					tokensByModel,
					usd,
					wallMinutes: (Date.now() - started.getTime()) / 60_000,
					workMinutes: sessions.reduce((a, x) => a + x.s.minutes, 0),
				},
				integration: { mergeConflicts: conflicts, lateFailures: 0 },
				// A person reviews each branch's diff before merging it, as the other arms count.
				human: { decisions: kids.length, waitingMinutes: 0 },
			},
		};
	},
};

/** One session's brief: the epic's ticket and its own child's in full, not the others'. */
export function childBrief(
	ctx: ArmContext,
	key: string,
	touches: string[],
): string {
	const scenarios = ctx.epic.scenarios
		.map((s) => `- ${s.id}: ${s.text}`)
		.join("\n");
	return `You are working on ticket ${key}, part of the feature "${ctx.epic.title}" (${ctx.epic.key}) in this repository. Other tickets of the feature are being worked on at the same time by other sessions in their own copies of the repository.

The feature's acceptance scenarios, for context:
${scenarios}

Your ticket is expected to change these paths: ${touches.join(", ")}.

The feature's ticket, then yours, word for word as they are filed in the tracker:

${ticket(ctx.epic.key, ctx.tickets.epic)}

${ticket(key, childTicket(ctx, key))}

Follow the repository's own CLAUDE.md, lint, typecheck and tests. Commit on the current branch as you go. Do not push. Stop when the ticket is done and the repository's checks pass, and say which scenarios your change proves.`;
}
