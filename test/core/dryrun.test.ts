import { expect, it } from "vitest";
import { dryRun } from "../../src/core/exec";
import { fakeExec } from "../helpers/fake-exec";

it("logs mutating commands instead of running them, and passes reads through", async () => {
	const inner = fakeExec(() => ({ stdout: "read" }));
	const logged: string[] = [];
	const exec = dryRun(inner.exec, (s) => logged.push(s));
	expect((await exec("git", ["fetch", "origin"])).stdout).toBe("read");
	expect((await exec("gh", ["pr", "list", "--json", "number"])).stdout).toBe(
		"read",
	);
	expect((await exec("gh", ["pr", "create", "--title", "t"])).stdout).toContain(
		"/pull/1",
	);
	await exec("git", ["push", "origin", "HEAD:main"]);
	await exec("gh", ["pr", "merge", "42"]);
	await exec("createdb", ["x"]);
	await exec("sh", ["-c", "bunx jest"]);
	expect(inner.calls.map(inner.line)).toEqual([
		"git fetch origin",
		"gh pr list --json number",
	]);
	expect(logged).toEqual([
		"[dry-run] gh pr create --title t",
		"[dry-run] git push origin HEAD:main",
		"[dry-run] gh pr merge 42",
		"[dry-run] createdb x",
		"[dry-run] sh -c bunx jest",
	]);
});

it("treats git worktree list and gh pr view as reads, and blocks the other mutations", async () => {
	const inner = fakeExec();
	const logged: string[] = [];
	const exec = dryRun(inner.exec, (s) => logged.push(s));
	await exec("git", ["worktree", "list"]);
	await exec("gh", ["pr", "view", "1"]);
	await exec("git", ["worktree", "add", "x"]);
	await exec("git", ["rebase", "main"]);
	await exec("docker", ["run", "x"]);
	await exec("bun", ["install"]);
	await exec("sh", ["-c", "run-migrations"]);
	expect(inner.calls.map(inner.line)).toEqual([
		"git worktree list",
		"gh pr view 1",
	]);
	expect(logged).toHaveLength(5);
});

it("classifies gh api by method and body, not by the path", async () => {
	const inner = fakeExec();
	const logged: string[] = [];
	const exec = dryRun(inner.exec, (s) => logged.push(s));
	const reads = [
		["api", "repos/o/r/issues/1"],
		["api", "repos/o/r/issues/1/sub_issues", "--paginate", "--slurp"],
		["api", "-X", "GET", "repos/o/r/issues"],
		["api", "--method=get", "repos/o/r/issues"],
		["api", "-X", "GET", "repos/o/r/issues", "-f", "state=open"],
		["api", "--method", "GET", "repos/o/r/issues", "-F", "per_page=100"],
	];
	const writes = [
		["api", "-X", "POST", "repos/o/r/issues/1/comments"],
		["api", "--method", "DELETE", "repos/o/r/issues/1/labels/x"],
		["api", "repos/o/r/issues/1/comments", "-f", "body=hi"],
		["api", "repos/o/r/issues/1/comments", "-fbody=hi"],
		["api", "repos/o/r/issues", "--raw-field", "title=t"],
		["api", "repos/o/r/issues", "--field=title=t"],
		["api", "-X", "PUT", "repos/o/r/issues/1/labels", "--input", "-"],
		["api", "repos/o/r/issues/1/labels", "--input", "-"],
		["api", "-XPATCH", "repos/o/r/issues/1"],
		["api", "--method=POST", "repos/o/r/issues/1/comments"],
		["api", "-XPOST", "repos/o/r/issues/1/comments"],
	];
	for (const a of [...reads, ...writes]) await exec("gh", a);
	expect(inner.calls.map((c) => c.args)).toEqual(reads);
	expect(logged).toHaveLength(writes.length);
});
