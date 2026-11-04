import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { must, realExec } from "../../src/core/exec";
import { excludeLocally } from "../../src/env/env";

const git = (cwd: string, ...args: string[]) =>
	must(realExec, "git", args, { cwd });

it("keeps a file Portia writes in a worktree out of git status, without touching .gitignore", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-exclude-"));
	const repo = join(dir, "repo");
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	writeFileSync(join(repo, "README.md"), "hi\n");
	await git(repo, "add", "-A");
	await git(
		repo,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-qm",
		"base",
	);
	const wt = join(dir, "wt");
	await git(repo, "worktree", "add", "-q", "-b", "child", wt);
	writeFileSync(join(wt, ".env.portia"), "PORT=3200\n");
	expect(await git(wt, "status", "--porcelain")).toContain(".env.portia");

	await excludeLocally(realExec, wt, ".env.portia");
	await excludeLocally(realExec, wt, ".env.portia");

	expect(await git(wt, "status", "--porcelain")).not.toContain(".env.portia");
	// Not even `git add -A` takes it, and the repository's own files are unchanged.
	await git(wt, "add", "-A");
	expect(await git(wt, "diff", "--cached", "--name-only")).toBe("");
	expect(await git(wt, "status", "--porcelain")).not.toContain(".gitignore");
	const exclude = (
		await git(wt, "rev-parse", "--git-path", "info/exclude")
	).trim();
	const path = exclude.startsWith("/") ? exclude : join(wt, exclude);
	expect(
		readFileSync(path, "utf8")
			.split("\n")
			.filter((l) => l === "/.env.portia"),
	).toHaveLength(1);
});
