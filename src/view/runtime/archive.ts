import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * The one write the view makes: a finished run's directory moved from `runs/<KEY>` to
 * `runs/.archive/<KEY>`, which Home does not list. Nothing is deleted; moving it back
 * brings it back. A run archived before keeps its copy, and this one takes a suffix.
 * Returns where it went.
 */
export function archiveRun(runsDir: string, key: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key))
		throw new Error(`not a run key: ${key}`);
	const into = join(runsDir, ".archive");
	let to = join(into, key);
	mkdirSync(into, { recursive: true });
	if (existsSync(to)) to = `${to}-${Date.now()}`;
	renameSync(join(runsDir, key), to);
	return to;
}
