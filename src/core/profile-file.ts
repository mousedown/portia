import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { PortiaProblem } from "./exit";
import { portiaHome } from "./rundir";

export const PROFILE_FILE = "portia.config.ts";

/**
 * The user's private profiles: `<PORTIA_HOME>/profiles`, so `~/.portia/profiles` by default.
 * `--dry-run` moves PORTIA_HOME to a temp dir and pins this to the real one first.
 */
export function profilesHome(
	env: Record<string, string | undefined> = process.env,
): string {
	return env.PORTIA_PROFILES_DIR ?? join(portiaHome(env), "profiles");
}

export interface ProfileLocation {
	file: string;
	/** env: PORTIA_PROFILE; repo: portia.config.ts at the repo root; home: ~/.portia/profiles. */
	via: "env" | "repo" | "home";
}
export interface LocateOpts {
	/** The target repository's name; defaults to the repo root's folder name. */
	repoName?: string;
	/** Test seam: where the user's profiles live; defaults to profilesHome(). */
	profilesDir?: string;
}

/**
 * The target repository's name from `git rev-parse --git-common-dir`, which is the main
 * checkout's `.git` from any worktree: a child worktree's own folder is named after the
 * child key, so it says nothing about the repository.
 */
export function repoNameFromCommonDir(commonDir: string): string {
	const dir = resolve(commonDir.trim());
	const name = basename(dir);
	return name === ".git" ? basename(dirname(dir)) : name.replace(/\.git$/, "");
}

/**
 * Where the profile lives, first match wins: `PORTIA_PROFILE` (an absolute path), then
 * `portia.config.ts` at the root of the repository Portia runs in, then
 * `~/.portia/profiles/<repo name>.ts`. Portia ships no profiles of its own.
 */
export function locateProfile(
	repoRoot: string,
	opts: LocateOpts = {},
): ProfileLocation {
	const override = process.env.PORTIA_PROFILE;
	if (override) {
		if (!isAbsolute(override))
			throw new PortiaProblem("PORTIA_PROFILE must be an absolute path");
		const file = resolve(override);
		if (!existsSync(file))
			throw new PortiaProblem(
				`PORTIA_PROFILE points at ${file}, which does not exist`,
			);
		return { file, via: "env" };
	}
	const local = join(repoRoot, PROFILE_FILE);
	if (existsSync(local)) return { file: local, via: "repo" };
	const mine = join(
		opts.profilesDir ?? profilesHome(),
		`${opts.repoName ?? basename(repoRoot)}.ts`,
	);
	if (existsSync(mine)) return { file: mine, via: "home" };
	throw new PortiaProblem(
		`no profile found: PORTIA_PROFILE is not set, there is no ${PROFILE_FILE} in ${repoRoot}, and there is no ${mine}`,
	);
}

export const findProfileFile = (repoRoot: string, opts: LocateOpts = {}) =>
	locateProfile(repoRoot, opts).file;
