import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../core/atomic";
import { integrationBranch } from "../core/branches";
import type { Profile } from "../core/config";
import { type Exec, isDryRun, must } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import type { ParentPlan } from "../core/types";
import { withLock } from "../gate/lock";
import type { GateReport } from "../gate/run";
import { END, START } from "../ledger/render";
import type { Tracker } from "../plan/tracker";

export interface LandCtx {
	exec: Exec;
	profile: Profile;
	repoRoot: string;
	dir: string;
	plan: ParentPlan;
	tracker: Pick<Tracker, "transition">;
	/**
	 * A PR merged into the integration branch that carries this child although it is not the
	 * child's own branch: one PR that built several children. The land records it landed from
	 * that PR, once its state and base check out.
	 */
	mergedIn?: number;
	/**
	 * The exit gate; `onto` is the integration commit the child was rebased onto, its base, and
	 * `landed` the children whose merge `onto` already holds, read under land.lock with it.
	 */
	gate: (
		key: string,
		onto?: string,
		landed?: ReadonlySet<string>,
	) => Promise<GateReport>;
	/** The checkout's files, so a republished ledger keeps each child's lane. */
	files?: string[];
	lockOpts?: { timeoutMs?: number; pollMs?: number };
	/**
	 * A fingerprint of everything but the tree the exit gate's verdict depends on (the profile,
	 * the child's lane, its owned scenarios and the regression guard's). With it, a land reuses its own
	 * earlier pass of the same tree on the same integration tip; without it, every land runs
	 * the gate.
	 */
	gateInputs?: (key: string, landed?: ReadonlySet<string>) => string;
	checksPollMs?: number;
	/** Test seam; TRACKER_TIMEOUT_MS by default. */
	trackerTimeoutMs?: number;
	/** Test seams; the profile's ciWaitMs is the real register wait. */
	checksWaitMs?: number;
	checksGraceMs?: number;
}

/** Serialises landings and main syncs; the heavy lock is left to the gate's heavy steps. */
export const LAND_LOCK = "land.lock";
export const integrationWorktree = (p: Profile, parent: string) =>
	join(p.worktreesDir, p.repo, parent);
export const readEpic = (dir: string): { epicPr: number } =>
	JSON.parse(readFileSync(join(dir, "epic.json"), "utf8"));
export const prNumber = (url: string): number => {
	const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
	if (!n)
		throw new PortiaProblem(`could not read a PR number from '${url.trim()}'`);
	return n;
};

export async function initIntegration(
	ctx: LandCtx,
): Promise<{ epicPr: number }> {
	const { exec, repoRoot, plan, profile } = ctx;
	const branch = integrationBranch(profile, plan.key);
	await must(exec, "git", ["fetch", "origin"], { cwd: repoRoot });
	let fresh = false;
	if (
		(
			await exec("git", ["rev-parse", "--verify", `origin/${branch}`], {
				cwd: repoRoot,
			})
		).code !== 0
	) {
		// GitHub refuses a PR with no commits between base and head, so the branch starts
		// one empty commit ahead of main and the epic PR can open before anything lands.
		const opening = (
			await must(
				exec,
				"git",
				[
					"commit-tree",
					"origin/main^{tree}",
					"-p",
					"origin/main",
					"-m",
					`chore(${plan.scope}): ${plan.key} open the integration branch`,
				],
				{ cwd: repoRoot },
			)
		).trim();
		await must(
			exec,
			"git",
			["push", "origin", `${opening}:refs/heads/${branch}`],
			{ cwd: repoRoot },
		);
		fresh = true;
		if (!isDryRun())
			await must(exec, "git", ["fetch", "origin", branch], { cwd: repoRoot });
	}
	const wt = integrationWorktree(profile, plan.key);
	if (fresh && isDryRun())
		console.error(
			`[dry-run] git fetch origin ${branch}; git worktree add ${wt} (branch not on origin)`,
		);
	else if (!existsSync(wt)) {
		await must(
			exec,
			"git",
			["worktree", "add", "-B", branch, wt, `origin/${branch}`],
			{ cwd: repoRoot },
		);
		// So `portia gate baseline` type-checks against installed dependencies.
		if (existsSync(join(wt, "package.json")))
			await must(exec, "bun", ["install", "--frozen-lockfile"], { cwd: wt });
	}
	const open = JSON.parse(
		(await must(
			exec,
			"gh",
			[
				"pr",
				"list",
				"--head",
				branch,
				"--base",
				"main",
				"--state",
				"open",
				"--json",
				"number",
			],
			{ cwd: repoRoot },
		)) || "[]",
	) as { number: number }[];
	const epicPr =
		open[0]?.number ??
		prNumber(
			await must(
				exec,
				"gh",
				[
					"pr",
					"create",
					"--draft",
					"--base",
					"main",
					"--head",
					branch,
					"--title",
					`feat(${plan.scope}): ${plan.key} ${plan.summary}`,
					"--body",
					`${START}\n${END}`,
				],
				{ cwd: repoRoot },
			),
		);
	writeFileAtomic(join(ctx.dir, "epic.json"), JSON.stringify({ epicPr }));
	return { epicPr };
}

/** R5: bring main into the integration branch before each wave; a conflict stops the wave. */
export const syncMain = (ctx: LandCtx): Promise<void> =>
	withLock(ctx.dir, () => syncMainLocked(ctx), {
		...ctx.lockOpts,
		name: LAND_LOCK,
	});

async function syncMainLocked(ctx: LandCtx): Promise<void> {
	const wt = integrationWorktree(ctx.profile, ctx.plan.key);
	await must(ctx.exec, "git", ["fetch", "origin"], { cwd: wt });
	await must(
		ctx.exec,
		"git",
		[
			"reset",
			"--hard",
			`origin/${integrationBranch(ctx.profile, ctx.plan.key)}`,
		],
		{ cwd: wt },
	);
	const merged = await ctx.exec("git", ["merge", "--no-edit", "origin/main"], {
		cwd: wt,
	});
	if (merged.code !== 0) {
		await ctx.exec("git", ["merge", "--abort"], { cwd: wt });
		throw new PortiaProblem(
			`main conflicts with ${integrationBranch(ctx.profile, ctx.plan.key)}; resolve it by hand in ${wt}, push, then rerun (R5)`,
		);
	}
	await must(
		ctx.exec,
		"git",
		["push", "origin", `HEAD:${integrationBranch(ctx.profile, ctx.plan.key)}`],
		{ cwd: wt },
	);
}
