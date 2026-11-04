import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec, ExecResult } from "../../src/core/exec";

interface Pr {
	number: number;
	head: string;
	base: string;
	title: string;
	body: string;
	draft: boolean;
	state: "open" | "merged";
	mergeCommit?: string;
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });
const opt = (args: string[], name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Emulates the `gh pr` calls Portia makes against a bare git repository standing in for
 * GitHub: PRs live in memory, and a squash merge is a real squash commit pushed to the
 * base branch. Every other command goes to `inner`. Anything unexpected fails loudly.
 */
export function localGitHub(origin: string, scratch: string, inner: Exec) {
	const prs: Pr[] = [];
	const clone = join(scratch, "merge-clone");
	const git = async (cwd: string, ...args: string[]) => {
		const r = await inner("git", args, { cwd });
		if (r.code !== 0)
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
		return r.stdout.trim();
	};
	const remoteSha = async (branch: string) =>
		(
			await inner("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
				cwd: origin,
			})
		).stdout.trim();
	const byNumber = (args: string[]) => {
		const pr = prs.find((p) => p.number === Number(args[2]));
		if (!pr) throw new Error(`no PR #${args[2]}`);
		return pr;
	};

	async function squash(pr: Pr): Promise<ExecResult> {
		if (!existsSync(clone)) {
			await git(scratch, "clone", "-q", origin, clone);
			await git(clone, "config", "user.email", "github@example.com");
			await git(clone, "config", "user.name", "Local GitHub");
		}
		await git(clone, "fetch", "-q", "origin");
		await git(clone, "checkout", "-q", "-B", "merging", `origin/${pr.base}`);
		const merged = await inner(
			"git",
			["merge", "--squash", `origin/${pr.head}`],
			{ cwd: clone },
		);
		if (merged.code !== 0) {
			await inner("git", ["reset", "--hard", "-q"], { cwd: clone });
			return fail(`Pull request #${pr.number} is not mergeable`);
		}
		await git(clone, "commit", "-q", "-m", `${pr.title} (#${pr.number})`);
		await git(clone, "push", "-q", "origin", `HEAD:refs/heads/${pr.base}`);
		pr.state = "merged";
		pr.mergeCommit = await git(clone, "rev-parse", "HEAD");
		return ok();
	}

	const pick = (pr: Pr, fields: string[]) =>
		Object.fromEntries(
			fields.map((f) => [
				f,
				f === "number"
					? pr.number
					: f === "headRefName"
						? pr.head
						: f === "mergeCommit"
							? pr.mergeCommit
								? { oid: pr.mergeCommit }
								: null
							: f === "body"
								? pr.body
								: f === "isDraft"
									? pr.draft
									: f === "state"
										? pr.state.toUpperCase()
										: f === "statusCheckRollup"
											? [
													{
														__typename: "CheckRun",
														name: "test",
														status: "COMPLETED",
														conclusion: "SUCCESS",
													},
												]
											: undefined,
			]),
		);

	async function gh(args: string[]): Promise<ExecResult> {
		if (args[0] !== "pr")
			return fail(`local GitHub does not emulate gh ${args.join(" ")}`);
		switch (args[1]) {
			case "list": {
				const head = opt(args, "--head");
				const base = opt(args, "--base");
				const state = opt(args, "--state") ?? "open";
				const fields = (opt(args, "--json") ?? "number").split(",");
				const hits = prs
					.filter(
						(p) =>
							(!head || p.head === head) &&
							(!base || p.base === base) &&
							(state === "all" || p.state === state),
					)
					.reverse();
				const picked = [];
				for (const p of hits) {
					const one = pick(p, fields);
					if (fields.includes("headRefOid"))
						one.headRefOid = await remoteSha(p.head);
					picked.push(one);
				}
				return ok(JSON.stringify(picked));
			}
			case "create": {
				const head = opt(args, "--head") ?? "";
				const base = opt(args, "--base") ?? "";
				const [h, b] = [await remoteSha(head), await remoteSha(base)];
				if (!h || !b) return fail(`Head or base ref does not exist`);
				const ahead = await inner(
					"git",
					["rev-list", "--count", `${b}..${h}`],
					{
						cwd: origin,
					},
				);
				if (ahead.stdout.trim() === "0")
					return fail(
						`pull request create failed: GraphQL: No commits between ${base} and ${head} (createPullRequest)`,
					);
				const pr: Pr = {
					number: prs.length + 1,
					head,
					base,
					title: opt(args, "--title") ?? "",
					body: opt(args, "--body") ?? "",
					draft: args.includes("--draft"),
					state: "open",
				};
				prs.push(pr);
				return ok(
					`https://github.com/local/portia-fixture/pull/${pr.number}\n`,
				);
			}
			case "checks":
				byNumber(args);
				return ok(JSON.stringify([{ name: "test", bucket: "pass" }]));
			case "merge": {
				const pr = byNumber(args);
				if (pr.state !== "open") return fail(`PR #${pr.number} is not open`);
				if (pr.draft) return fail(`PR #${pr.number} is still a draft`);
				const pinned = opt(args, "--match-head-commit");
				if (pinned && pinned !== (await remoteSha(pr.head)))
					return fail(
						"Head branch was modified. Review and try the merge again.",
					);
				return squash(pr);
			}
			case "ready":
				byNumber(args).draft = false;
				return ok();
			case "view": {
				const fields = (opt(args, "--json") ?? "number").split(",");
				const pr = byNumber(args);
				const picked = pick(pr, fields);
				if (fields.includes("headRefOid"))
					picked.headRefOid = await remoteSha(pr.head);
				return ok(
					opt(args, "-q") === ".body"
						? `${picked.body}\n`
						: JSON.stringify(picked),
				);
			}
			case "edit": {
				const file = opt(args, "--body-file");
				if (!file) return fail("local GitHub only edits PR bodies");
				byNumber(args).body = readFileSync(file, "utf8");
				return ok();
			}
			default:
				return fail(`local GitHub does not emulate gh ${args.join(" ")}`);
		}
	}

	const exec: Exec = (cmd, args, opts) =>
		cmd === "gh" ? gh(args) : inner(cmd, args, opts);
	return { exec, prs };
}
