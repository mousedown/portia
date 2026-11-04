import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };

/**
 * This code's version and commit, `v0.1.0 cc5400f`, or the version alone when it is not a
 * git checkout, as with a package install. The version stays put between releases, so
 * the commit is what tells one build from another.
 */
export function buildLabel(
	root = join(dirname(fileURLToPath(import.meta.url)), "../.."),
): string {
	const version = `v${pkg.version}`;
	const git = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
		encoding: "utf8",
		timeout: 2000,
	});
	const commit = git.status === 0 ? git.stdout.trim() : "";
	return commit ? `${version} ${commit}` : version;
}
