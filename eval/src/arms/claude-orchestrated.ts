import type { Arm } from ".";
import { epicBrief } from "./claude";
import { oneBranch, savedOneBranch } from "./claude-serial";

/**
 * Native Claude Code left to orchestrate the epic itself: claude-serial's brief, plus an
 * explicit invitation to plan first and fan out to subagents and worktrees. The rival a
 * sceptic would name, so Portia has to beat it with the same model, permissions and cap.
 */
export const claudeOrchestrated: Arm = {
	name: "claude-orchestrated",
	description:
		"One Claude Code session given the epic and invited to plan first and use subagents and worktrees as it sees fit, then sent back while the repo's checks fail.",
	run: (ctx) =>
		oneBranch(ctx, "claude-orchestrated", `${epicBrief(ctx)}\n\n${INVITATION}`),
	rebuild: (ctx) => savedOneBranch(ctx, "claude-orchestrated"),
};

export const INVITATION =
	"How you organise the work is up to you. Plan it first. Use subagents for work that can run in parallel, and give them their own git worktrees when they would otherwise get in each other's way. Whatever is done in a worktree must be merged onto the current branch before you stop: only the current branch is delivered.";
