import { loadProfileFile, type Profile } from "../core/config";
import { must, realExec } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import { writePlanSnapshot } from "../core/plan-snapshot";
import {
	locateProfile,
	type ProfileLocation,
	repoNameFromCommonDir,
} from "../core/profile-file";
import { runDir, setRunOwner } from "../core/rundir";
import { scheduleOf } from "../core/state";
import type { Finding, ParentPlan } from "../core/types";
import { BlockError } from "../plan/block";
import { loadPlan } from "../plan/load";
import { repoFiles, topLevelOf } from "../plan/repo";
import {
	type Tracker,
	type TrackerIssue,
	trackerFromProfile,
} from "../plan/tracker";

/**
 * Loads the plan. A child whose portia block fails to parse is dropped from the plan, so
 * acting on it would silently shorten the epic: refuse (exit 11) unless the caller opts in
 * to see the findings, as `portia check` does. Unplanned children are only a warning.
 */
export async function loadForCli(
	key: string,
	opts: { allowFindings?: boolean } = {},
): Promise<{
	plan: ParentPlan;
	files: string[];
	dir: string;
	findings: Finding[];
	/** The children as the tracker returned them, so a caller need not fetch one again. */
	issues: TrackerIssue[];
}> {
	const [{ profile, tracker }, files] = await Promise.all([
		cliContext(),
		repoFiles(realExec, process.cwd()),
	]);
	try {
		const { plan, findings, issues } = await loadPlan(
			tracker,
			key.toUpperCase(),
			topLevelOf(files),
			profile.packageDir,
			{ excludeLabels: profile.excludeLabels, questions: profile.askOnce },
		);
		const errors = findings.filter((f) => f.level === "error");
		if (errors.length && !opts.allowFindings)
			throw new PortiaProblem(
				`${plan.key} has ${errors.length} plan error(s); fix them and run portia check:\n${errors.map((f) => `  ${f.rule}${f.child ? ` ${f.child}` : ""}: ${f.message}`).join("\n")}`,
			);
		let snapshotted = false;
		return {
			plan,
			files,
			findings,
			issues: issues ?? [],
			// Lazy: runDir creates the directory, which `portia check` must not do. The
			// commands that own the run directory also record the plan for `portia view`.
			get dir() {
				const d = runDir(plan.key);
				if (!snapshotted) {
					snapshotted = true;
					writePlanSnapshot(d, plan, undefined, scheduleOf(profile));
				}
				return d;
			},
		};
	} catch (e) {
		if (e instanceof BlockError) throw new PortiaProblem(e.message);
		throw e;
	}
}

export interface CliContext {
	repoRoot: string;
	profile: Profile;
	/** The profile's file and how it was found. */
	profileFile: ProfileLocation;
	/** Built on first read, so commands that never touch the tracker need no tracker credentials. */
	readonly tracker: Tracker;
}

let trackerOverride: Tracker | undefined;
/**
 * Test seam: the tracker every command uses instead of the profile's. The end-to-end
 * suite runs the real commands against an in-memory tracker. Returns a restore function.
 */
export function useTracker(t: Tracker): () => void {
	const prev = trackerOverride;
	trackerOverride = t;
	return () => {
		trackerOverride = prev;
	};
}

/**
 * Where a directory's repository is, asked of git once per directory per process: one
 * command calls cliContext several times, and a directory never moves to another repo.
 * Only a successful answer is kept.
 */
const repos = new Map<
	string,
	Promise<{ repoRoot: string; repoName?: string }>
>();
function repoOf(cwd: string): Promise<{ repoRoot: string; repoName?: string }> {
	let found = repos.get(cwd);
	if (!found) {
		found = (async () => {
			const repoRoot = (
				await must(realExec, "git", ["rev-parse", "--show-toplevel"], { cwd })
			).trim();
			// From a child worktree the toplevel is named after the child, so name the
			// repository from its shared git dir.
			const common = await realExec(
				"git",
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ cwd },
			);
			return {
				repoRoot,
				repoName:
					common.code === 0 && common.stdout.trim()
						? repoNameFromCommonDir(common.stdout)
						: undefined,
			};
		})();
		repos.set(cwd, found);
		found.catch(() => repos.delete(cwd));
	}
	return found;
}

/** The repo Portia is running in (`git rev-parse --show-toplevel`) and its profile. */
export async function cliContext(): Promise<CliContext> {
	const { repoRoot, repoName } = await repoOf(process.cwd());
	const profileFile = locateProfile(repoRoot, { repoName });
	const profile = await loadProfileFile(profileFile.file);
	setRunOwner(profile);
	let tracker: Tracker | undefined;
	return {
		repoRoot,
		profile,
		profileFile,
		get tracker() {
			tracker ??= trackerOverride ?? trackerFromProfile(profile);
			return tracker;
		},
	};
}
