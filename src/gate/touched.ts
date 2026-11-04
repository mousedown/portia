import { integrationBranch } from "../core/branches";
import type { Profile } from "../core/config";
import { type Exec, must } from "../core/exec";

/**
 * Every file the child changed against its parent branch: tracked changes (committed or
 * not) plus untracked files, deduped. The gate must see work that is not committed yet.
 * `base` is the parent branch's tip by default; a land passes the commit it rebased onto.
 */
export async function touchedFiles(
	exec: Exec,
	profile: Profile,
	worktree: string,
	parent: string,
	base = `origin/${integrationBranch(profile, parent)}`,
): Promise<string[]> {
	const lines = async (args: string[]) =>
		(await must(exec, "git", args, { cwd: worktree }))
			.split("\n")
			.filter(Boolean);
	const tracked = await lines(["diff", "--name-only", base]);
	const untracked = await lines(["ls-files", "--others", "--exclude-standard"]);
	return [...new Set([...tracked, ...untracked])];
}
