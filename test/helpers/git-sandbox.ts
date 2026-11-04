import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Exec,
	type ExecResult,
	must,
	realExec,
} from "../../src/core/exec";

export async function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "portia-git-"));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	const g = (cwd: string, ...args: string[]) =>
		must(realExec, "git", args, { cwd });
	await must(realExec, "git", ["init", "--bare", "-b", "main", origin]);
	await must(realExec, "git", ["clone", origin, repo]);
	await g(repo, "config", "user.email", "t@example.com");
	await g(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "a.txt"), "one\n");
	await g(repo, "add", ".");
	await g(repo, "commit", "-m", "init");
	await g(repo, "push", "origin", "HEAD:main");
	return { root, repo, g };
}

/** The PR's head as GitHub would report it once up to date: the pushed tip of the worktree's branch. */
async function pushedHead(cwd: string | undefined): Promise<string> {
	const branch = (
		await must(realExec, "git", ["branch", "--show-current"], { cwd })
	).trim();
	const out = await must(
		realExec,
		"git",
		["ls-remote", "origin", `refs/heads/${branch}`],
		{ cwd },
	);
	return out.split(/\s/)[0] ?? "";
}

const ROLLUP: Record<string, { status: string; conclusion?: string }> = {
	pass: { status: "COMPLETED", conclusion: "SUCCESS" },
	fail: { status: "COMPLETED", conclusion: "FAILURE" },
	cancel: { status: "COMPLETED", conclusion: "CANCELLED" },
	skipping: { status: "COMPLETED", conclusion: "SKIPPED" },
	pending: { status: "IN_PROGRESS" },
};

/**
 * Answer `gh pr view --json headRefOid,statusCheckRollup` from the fake's simpler answers: the
 * head from its `gh pr view --json headRefOid` (else the pushed head), the checks from its
 * `gh pr checks --json name,bucket` as gh would print them, turned into rollup entries.
 */
async function rollup(
	gh: (args: string[]) => Partial<ExecResult>,
	pr: string,
	cwd: string | undefined,
): Promise<ExecResult> {
	const view = gh(["pr", "view", pr, "--json", "headRefOid"]);
	if (view.code) return { code: view.code, stdout: "", stderr: "", ...view };
	let head: string | undefined;
	try {
		head = (JSON.parse(view.stdout ?? "") as { headRefOid?: string })
			.headRefOid;
	} catch {}
	head ??= await pushedHead(cwd);
	const checks = gh(["pr", "checks", pr, "--json", "name,bucket"]);
	const out = `${checks.stdout ?? ""}\n${checks.stderr ?? ""}`;
	let rows: { name: string; bucket: string }[] = [];
	if (!/no checks reported/i.test(out)) {
		if (checks.code && !checks.stdout?.trim())
			return { code: checks.code, stdout: "", stderr: checks.stderr ?? "" };
		try {
			rows = JSON.parse(checks.stdout || "[]");
		} catch {
			return { code: 1, stdout: "", stderr: checks.stderr ?? "" };
		}
	}
	const statusCheckRollup = rows.map((c) => ({
		__typename: "CheckRun",
		name: c.name,
		...ROLLUP[c.bucket],
	}));
	return {
		code: 0,
		stdout: JSON.stringify({ headRefOid: head, statusCheckRollup }),
		stderr: "",
	};
}

/**
 * Real git, fake gh. A `gh pr view --json headRefOid` the fake leaves unanswered reports the
 * pushed head, and a `gh pr view --json headRefOid,statusCheckRollup` it leaves unanswered is
 * built from its answers to `gh pr view --json headRefOid` and `gh pr checks`.
 */
export function hybridExec(
	gh: (args: string[]) => Partial<ExecResult> = () => ({}),
) {
	const ghCalls: string[][] = [];
	const exec: Exec = async (cmd, args, opts) => {
		if (cmd !== "gh") return realExec(cmd, args, opts);
		ghCalls.push(args);
		const r = gh(args);
		if (
			r.stdout === undefined &&
			r.code === undefined &&
			args[1] === "view" &&
			args.includes("headRefOid,statusCheckRollup")
		)
			return rollup(gh, args[2] ?? "", opts?.cwd);
		if (
			r.stdout === undefined &&
			r.code === undefined &&
			args[1] === "view" &&
			args.includes("headRefOid")
		)
			return {
				code: 0,
				stdout: JSON.stringify({ headRefOid: await pushedHead(opts?.cwd) }),
				stderr: "",
			};
		return { code: 0, stdout: "", stderr: "", ...r };
	};
	return { exec, ghCalls };
}
