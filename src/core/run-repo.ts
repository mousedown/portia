import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic";
import { PortiaProblem } from "./exit";

/** Which repository a run belongs to, in its directory. Run directories are named by key alone. */
export const RUN_REPO_FILE = "repo.json";

/** What opens runs: a profile's repository, and where it keeps worktrees. */
export interface RunOwner {
	repo: string;
	worktreesDir: string;
}

const worktreeOf = (text: string | undefined): string | undefined => {
	try {
		const w = (JSON.parse(text ?? "") as { worktree?: unknown })?.worktree;
		return typeof w === "string" && w ? w : undefined;
	} catch {
		return undefined;
	}
};

/** The repository named by a parsed `repo.json`. */
export function repoOfMark(mark: unknown): string | undefined {
	const repo = (mark as { repo?: unknown } | undefined)?.repo;
	return typeof repo === "string" && repo ? repo : undefined;
}

/** The repository a run's env or worker record points at: `<worktrees>/<repo>/<key>`. */
export function repoOfRecords(
	records: (string | undefined)[],
	worktreesDir?: string,
): string | undefined {
	for (const text of records) {
		const w = worktreeOf(text);
		if (!w) continue;
		const parent = dirname(w);
		if (worktreesDir === undefined || dirname(parent) === worktreesDir)
			return basename(parent);
	}
	return undefined;
}

function runRepo(dir: string, worktreesDir: string): string | undefined {
	const read = (name: string) => {
		try {
			return readFileSync(join(dir, name), "utf8");
		} catch {
			return undefined;
		}
	};
	const marked = read(RUN_REPO_FILE);
	if (marked !== undefined) {
		try {
			const repo = repoOfMark(JSON.parse(marked));
			if (repo) return repo;
		} catch {
			// A torn or hand-edited marker says nothing: read the records instead.
		}
	}
	const names = existsSync(dir) ? readdirSync(dir) : [];
	return repoOfRecords(
		names
			.filter((n) => /^(env|worker)-.*\.json$/.test(n))
			.filter((n) => !/\.(settings|mcp|cpu)\.json$/.test(n))
			.map(read),
		worktreesDir,
	);
}

/** Refuses a run another repository owns, so one repository never writes into another's log. */
export function assertRunOwner(
	key: string,
	dir: string,
	owner: RunOwner,
): string | undefined {
	const repo = runRepo(dir, owner.worktreesDir);
	if (repo && repo !== owner.repo)
		throw new PortiaProblem(
			`${key} is a run of ${repo}, and this repository is ${owner.repo}. Run directories are named by key, and keys repeat across repositories. Finish or archive that run (x in portia view) before using ${key} here.`,
		);
	return repo;
}

/**
 * Marks an open run with its owner, the first time it is opened. `dir` exists. A marker
 * that cannot be written must not fail the command, as with the plan snapshot.
 */
export function markRunOwner(dir: string, repo: string): void {
	const file = join(dir, RUN_REPO_FILE);
	try {
		if (!existsSync(file))
			writeFileAtomic(file, `${JSON.stringify({ repo })}\n`);
	} catch {
		// The run works without it; the next command tries again.
	}
}
