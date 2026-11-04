import picomatch from "picomatch";
import type { Profile } from "../core/config";
import { rippleClassifier } from "../core/ripple";
import type { Ripple } from "../core/types";

/** Another child in the same wave, by the paths it may change. */
export interface Sibling {
	key: string;
	touches: string[];
}

/** A file outside the child's touches that a ripple cannot carry. */
export interface Blocker {
	file: string;
	/** The same-wave child whose touches hold the file: the two would collide at land. */
	sibling?: string;
}

export interface OutsideSplit {
	/** Test and generated files that may ride along with the child. */
	ripples: Ripple[];
	/** Production, sensitive and colliding files, which need a decision. */
	blockers: Blocker[];
}

/**
 * Splits the files a child changed outside its touches into ripples it may carry and the
 * files that still need a decision: production code, anything under `sensitiveGlobs`, and
 * anything another child in the same wave touches.
 */
export function splitOutside(
	outside: string[],
	profile: Pick<Profile, "ripple" | "sensitiveGlobs">,
	siblings: Sibling[],
): OutsideSplit {
	const kind = rippleClassifier(profile.ripple);
	const sensitive = picomatch(profile.sensitiveGlobs, { dot: true });
	const owners = siblings.map((s) => ({
		key: s.key,
		has: picomatch(s.touches, { dot: true }),
	}));
	const split: OutsideSplit = { ripples: [], blockers: [] };
	for (const file of outside) {
		const sibling = owners.find((o) => o.has(file))?.key;
		if (sibling) {
			split.blockers.push({ file, sibling });
			continue;
		}
		const k = kind(file);
		if (k === "production" || sensitive(file)) split.blockers.push({ file });
		else split.ripples.push({ file, kind: k });
	}
	return split;
}

/** The blockers as a park names them: a colliding file with the child that touches it. */
export const describeBlockers = (blockers: Blocker[]) =>
	blockers
		.map((b) => (b.sibling ? `${b.file} (in ${b.sibling}'s touches)` : b.file))
		.join(", ");
