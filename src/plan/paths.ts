import { existsSync } from "node:fs";
import { join } from "node:path";

export function normaliseGlob(
	glob: string,
	topLevel: string[],
	packageDir: string,
): string {
	const g = glob.trim().replace(/^\.\//, "");
	const first = g.split("/")[0] ?? "";
	return topLevel.includes(first) || packageDir === "."
		? g
		: `${packageDir}/${g}`;
}

/** True when the repo-relative path `f` is under the package at `dir` (`.` is the whole repo). */
export const inPackage = (f: string, dir: string) =>
	dir === "." || f.startsWith(`${dir}/`);

/**
 * A spec path from a plan as a repo-relative path. Plans may write an acceptance path
 * repo-relative (`packages/web/e2e/a.e2e.ts`) or relative to the package
 * (`e2e/a.e2e.ts`); the latter is taken as package-relative unless it exists at the root.
 */
export const repoPath = (f: string, dir: string, root: string) =>
	dir === "." || inPackage(f, dir) || existsSync(join(root, f))
		? f
		: `${dir}/${f}`;

/** `f` relative to the package at `dir`; only meaningful when `inPackage(f, dir)`. */
export const pkgRelative = (f: string, dir: string) =>
	dir === "." ? f : f.slice(dir.length + 1);
