import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, sessionEnv, spawnExec } from "./arms/claude";
import { git, gitOk } from "./metrics/git";
import type { Epic, Repo } from "./suite";

/**
 * Exactly what `ref` has committed, checked out detached in a fresh worktree of the clone,
 * with the repo's setup run there: the tree every score reads. Detached, because an arm may
 * still hold the branch in a worktree of its own, and git refuses a second checkout of it.
 * Fresh, because the clone's working tree can hold what the arm or its tools left untracked
 * (a local settings file, a build output), which is not on the branch a person would merge.
 */
export async function scoringTree(
	clone: string,
	repo: Repo,
	ref: string,
	log: (line: string) => void,
): Promise<{ dir: string; remove: () => Promise<void> }> {
	const dir = mkdtempSync(join(tmpdir(), "eval-scored-"));
	const remove = async () => {
		await gitOk(clone, ["worktree", "remove", "--force", dir]);
		rmSync(dir, { recursive: true, force: true });
		await gitOk(clone, ["worktree", "prune"]);
	};
	try {
		await git(clone, ["worktree", "add", "--quiet", "--detach", dir, ref]);
		if (repo.setup) {
			log(`scoring ${ref} in a clean checkout; setup: ${repo.setup}`);
			const p = Bun.spawn(["sh", "-c", repo.setup], {
				cwd: dir,
				stdout: "ignore",
				stderr: "pipe",
			});
			if (await p.exited)
				throw new Error(`setup failed: ${await new Response(p.stderr).text()}`);
		}
	} catch (e) {
		await remove();
		throw e;
	}
	return { dir, remove };
}

/**
 * The hidden specs, then the repo's checks, on a clean checkout of the arm's branch
 * (`scoringTree`), removed again afterwards. The clone itself is never checked out.
 */
export async function scoreBranch(
	clone: string,
	repo: Repo,
	epic: Epic,
	hidden: string,
	o: {
		branch: string;
		childBranches?: string[];
		log: (line: string) => void;
		exec?: Exec;
	},
): Promise<{
	hidden: Awaited<ReturnType<typeof scoreHidden>>;
	checks: Awaited<ReturnType<typeof scoreChecks>>;
}> {
	const tree = await scoringTree(clone, repo, o.branch, o.log);
	try {
		return {
			hidden: await scoreHidden(tree.dir, repo, epic, hidden, o.log),
			checks: await scoreChecks(tree.dir, repo, o),
		};
	} finally {
		await tree.remove();
	}
}

/**
 * Hidden specs, one file per scenario, run one at a time in a checkout of the arm's final
 * branch with the repo's own test command. A scenario passes when its file exits 0. The
 * files are copied in only now, so no arm could have read them, and removed afterwards.
 */
export async function scoreHidden(
	cwd: string,
	repo: Repo,
	epic: Epic,
	hidden: string,
	log: (line: string) => void,
): Promise<{
	passed: string[];
	failed: string[];
	output: Record<string, string>;
}> {
	const target = join(cwd, ".eval-hidden");
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	const passed: string[] = [];
	const failed: string[] = [];
	const output: Record<string, string> = {};
	try {
		// Every file in the hidden directory goes in, helpers included; one spec per scenario runs.
		const files = existsSync(hidden) ? readdirSync(hidden) : [];
		for (const f of files)
			if (/\.(ts|js|json)$/.test(f))
				writeFileSync(join(target, f), await Bun.file(join(hidden, f)).text());
		for (const s of epic.scenarios) {
			const file = files.find((f) => f.startsWith(`${s.id}.`));
			if (!file) {
				log(`${s.id}: no hidden spec in ${hidden}`);
				failed.push(s.id);
				output[s.id] = "no hidden spec";
				continue;
			}
			const cmd = repo.test.replaceAll("{file}", join(target, file));
			const p = Bun.spawn(["sh", "-c", cmd], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(p.stdout).text(),
				new Response(p.stderr).text(),
				p.exited,
			]);
			output[s.id] = `${out}\n${err}`.trim();
			(code === 0 ? passed : failed).push(s.id);
			log(`${s.id}: ${code === 0 ? "pass" : `fail (${code})`}`);
		}
	} finally {
		rmSync(target, { recursive: true, force: true });
	}
	return { passed, failed, output };
}

/** Runs each named check in `cwd`, in the environment the scripted reviewer gives them. */
async function runRepoChecks(
	cwd: string,
	checks: string[],
	exec: Exec,
): Promise<{ failed: string[]; output: Record<string, string> }> {
	const failed: string[] = [];
	const output: Record<string, string> = {};
	for (const check of checks) {
		const r = await exec(["sh", "-c", check], {
			cwd,
			env: sessionEnv(process.env),
		});
		output[check] = `${r.stdout}${r.stderr}`.slice(-4000);
		if (r.exitCode) failed.push(check);
	}
	return { failed, output };
}

/**
 * The repo's own checks on the arm's final branch, which must be checked out in `cwd`:
 * correctness as a person would see it before merging. Then late failures: a check that
 * fails there though every child branch passed it on its own, so it only broke once they
 * were together. Each child branch is checked out detached in `cwd` in turn, so the setup's
 * installs carry over, and only for the checks that failed. A child that cannot be checked
 * out is taken to have failed them too: a failure is called late only when every child is
 * shown to pass. The final branch's commit is checked out again afterwards, detached.
 */
export async function scoreChecks(
	cwd: string,
	repo: Repo,
	o: {
		branch: string;
		childBranches?: string[];
		log: (line: string) => void;
		exec?: Exec;
	},
): Promise<{
	failed: string[];
	late: string[];
	output: Record<string, Record<string, string>>;
}> {
	const exec = o.exec ?? spawnExec;
	const final = await runRepoChecks(cwd, repo.checks, exec);
	for (const c of repo.checks)
		o.log(`check ${c}: ${final.failed.includes(c) ? "fail" : "pass"}`);
	const output: Record<string, Record<string, string>> = {
		[o.branch]: final.output,
	};
	const children = o.childBranches ?? [];
	if (!final.failed.length || !children.length)
		return { failed: final.failed, late: [], output };
	let late = final.failed;
	try {
		for (const child of children) {
			// Detached, since an arm may still have the branch checked out in a worktree.
			if (!(await gitOk(cwd, ["checkout", "--quiet", "--detach", child]))) {
				o.log(`${child}: cannot check out, so no failure is called late`);
				late = [];
				break;
			}
			const r = await runRepoChecks(cwd, late, exec);
			output[child] = r.output;
			late = late.filter((c) => !r.failed.includes(c));
			if (!late.length) break;
		}
	} finally {
		await git(cwd, ["checkout", "--quiet", "--detach", o.branch]);
	}
	for (const c of late)
		o.log(`late failure: ${c} passes on every child branch`);
	return { failed: final.failed, late, output };
}
