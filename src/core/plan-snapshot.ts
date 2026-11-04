import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ParentPlan } from "./types";

export const PLAN_FILE = "plan.json";

export interface PlanSnapshot {
	version: 1;
	at: string;
	plan: ParentPlan;
	/** Set when the profile gates each wave, so the view holds a wave back as `status` does. */
	waveGate?: true;
	/** Set when children wait only on their needs, the spine and shared files, not whole waves. */
	byNeeds?: true;
}

/**
 * Records the plan beside the run log so `portia view` can show what only the tracker
 * holds: the parent summary, needs and scenarios. An unchanged plan is left alone, so its
 * mtime stays put. A snapshot must never fail a command, so every error is swallowed.
 */
export function writePlanSnapshot(
	dir: string,
	plan: ParentPlan,
	now = new Date(),
	opts: { waveGate?: boolean; byNeeds?: boolean } = {},
): void {
	const path = join(dir, PLAN_FILE);
	const tmp = `${path}.tmp-${process.pid}`;
	try {
		const fresh = JSON.parse(JSON.stringify(plan));
		if (existsSync(path)) {
			const prev = JSON.parse(readFileSync(path, "utf8"));
			if (
				prev?.version === 1 &&
				isDeepStrictEqual(prev.plan, fresh) &&
				prev.waveGate === (opts.waveGate || undefined) &&
				prev.byNeeds === (opts.byNeeds || undefined)
			)
				return;
		}
		const snap: PlanSnapshot = {
			version: 1,
			at: now.toISOString(),
			plan: fresh,
			...(opts.waveGate ? { waveGate: true as const } : {}),
			...(opts.byNeeds ? { byNeeds: true as const } : {}),
		};
		writeFileSync(tmp, `${JSON.stringify(snap, null, "\t")}\n`);
		renameSync(tmp, path);
	} catch {
		// A read-only or vanished run directory: the view falls back to the ledger.
		try {
			rmSync(tmp, { force: true });
		} catch {}
	}
}
