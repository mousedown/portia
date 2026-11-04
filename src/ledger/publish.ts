import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tempPath } from "../core/atomic";
import { type Exec, must, NET_TIMEOUT_MS } from "../core/exec";
import { withLock } from "../gate/lock";
import { readEpic } from "../land/integration";
import { replaceRegion } from "./render";

export const LEDGER_LOCK = "ledger.lock";
const LEDGER_BODY = "ledger-body.md";
export const CLOSES = "closes.md";

const closing = (dir: string) => {
	const file = join(dir, CLOSES);
	return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
};

/**
 * Rewrites only the marked region of the epic PR body. Publishes are serialised, and markdown
 * given as a callback is rendered only once the lock is held, so the last writer renders
 * from the newest run log. Each publish writes the body to its own file, then moves it into
 * place as `ledger-body.md`, the copy the view falls back on.
 */
export async function publishLedger(
	exec: Exec,
	dir: string,
	markdown: string | (() => string),
): Promise<void> {
	const { epicPr } = readEpic(dir);
	await withLock(
		dir,
		async () => {
			const body = await must(exec, "gh", [
				"pr",
				"view",
				String(epicPr),
				"--json",
				"body",
				"-q",
				".body",
			]);
			const closes = closing(dir);
			const ledger = typeof markdown === "string" ? markdown : markdown();
			const region = closes ? `${ledger}\n\n${closes}` : ledger;
			const final = join(dir, LEDGER_BODY);
			const file = tempPath(final);
			try {
				writeFileSync(file, replaceRegion(body.trimEnd(), region));
			} catch (e) {
				// A short write is never moved into place.
				rmSync(file, { force: true });
				throw e;
			}
			try {
				// Not a retried read, so withNetRetry leaves it unbounded; a hung edit would hold
				// ledger.lock, and every other publish would time out behind it.
				await must(
					exec,
					"gh",
					["pr", "edit", String(epicPr), "--body-file", file],
					{ timeoutMs: NET_TIMEOUT_MS.gh },
				);
			} finally {
				try {
					renameSync(file, final);
				} catch {
					rmSync(file, { force: true });
				}
			}
		},
		{ name: LEDGER_LOCK, pollMs: 200, timeoutMs: 10 * 60_000 },
	);
}
