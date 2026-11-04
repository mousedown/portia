import picomatch from "picomatch";
import { integrationBranch } from "../core/branches";
import type { Profile } from "../core/config";
import { type Exec, must } from "../core/exec";
import { appendRow, readRows } from "../core/runlog";
import type { Ripple, SpecClaim } from "../core/types";
import { readEnv } from "../env/env";
import { withLock } from "../gate/lock";
import type { Tracker } from "../plan/tracker";
import type { ParseOutcome } from "./parse";
import { describeBlockers, type Sibling, splitOutside } from "./ripples";

export interface ApplyCtx {
	exec: Exec;
	profile: Pick<Profile, "branchPrefix" | "ripple" | "sensitiveGlobs">;
	dir: string;
	parent: string;
	tracker: Pick<Tracker, "comment">;
	touches: string[];
	/** The acceptance specs of the scenarios this child owns: the only ones it may claim cannot pass. */
	owned?: { id: string; path: string }[];
	/** The other children in this child's wave; a file in their touches is never a ripple. */
	siblings?: Sibling[];
	attempt: number;
	requestedModel: string;
	tokens?: number;
	decideTouches?: (outside: string[]) => Promise<"accept" | "park">;
	/** Called once a park is recorded, to tell the person. */
	onPark?: (park: { question: string; attempt: number }) => Promise<unknown>;
}
export interface Applied {
	status: "done" | "parked" | "failed";
	duplicate: boolean;
	outside: string[];
	message: string;
}

/** The result already recorded for this attempt, as a duplicate (S2). */
function applied(ctx: ApplyCtx, key: string): Applied | undefined {
	const prior = readRows(ctx.dir).rows.find(
		(r) => r.child === key && r.stage === "result" && r.attempt === ctx.attempt,
	);
	return prior
		? {
				status: prior.status as Applied["status"],
				duplicate: true,
				outside: [],
				message: "this attempt was already applied (S2)",
			}
		: undefined;
}

const bare = (p: string) => p.trim().replace(/^\.\//, "");

/**
 * The scenario whose spec a claim names, when the child owns it: the claim's path is the
 * spec's, or ends with it (a path from the repo root for a spec under the package).
 */
export function claimedScenario(
	claim: SpecClaim,
	owned: { id: string; path: string }[],
): { id: string; path: string } | undefined {
	const p = bare(claim.path);
	return owned.find(
		(o) => p === bare(o.path) || p.endsWith(`/${bare(o.path)}`),
	);
}

/**
 * Records a worker's outcome once per attempt. The slow checks run first; the re-check
 * and the row are taken under a per-child lock, so concurrent reconcilers (`worker wait`,
 * `resume`, `dispatch`) never record one attempt twice.
 */
export async function applyOutcome(
	outcome: ParseOutcome,
	key: string,
	ctx: ApplyCtx,
): Promise<Applied> {
	const early = applied(ctx, key);
	if (early) return early;

	let status: Applied["status"];
	let message: string;
	let outside: string[] = [];
	let ripples: Ripple[] = [];
	let touchesMatched: boolean | undefined;
	let head: string | undefined;
	let spec: (SpecClaim & { scenario: string }) | undefined;
	if (!outcome.ok) {
		status = "failed";
		message = outcome.error;
	} else {
		const r = outcome.result;
		status = r.status;
		message =
			r.question ??
			r.reason ??
			`done; evidence for ${Object.keys(r.evidence).join(", ")}`;
		// A spec that cannot pass is a question about the spec, whether the worker parked or
		// failed on it: parked, for the spine to amend. Only a spec of its own scenarios counts.
		const owns = r.spec && claimedScenario(r.spec, ctx.owned ?? []);
		if (r.spec && owns) {
			spec = { ...r.spec, path: owns.path, scenario: owns.id };
			status = "parked";
			message = `its acceptance spec ${owns.path} (${owns.id}) cannot pass as written: ${r.spec.assertion}${r.question ? `\n\n${r.question}` : ""}`;
		} else if (r.spec && !r.question && !r.reason)
			message = `it names ${r.spec.path} as a spec that cannot pass, which is not an acceptance spec of its own scenarios: ${r.spec.assertion}`;
		const env = readEnv(ctx.dir, key);
		head = (
			await must(ctx.exec, "git", ["rev-parse", "HEAD"], { cwd: env.worktree })
		).trim();
		const changed = (
			await must(
				ctx.exec,
				"git",
				[
					"diff",
					"--name-only",
					`origin/${integrationBranch(ctx.profile, ctx.parent)}...HEAD`,
				],
				{ cwd: env.worktree },
			)
		)
			.split("\n")
			.filter(Boolean);
		const inTouches = picomatch(ctx.touches, { dot: true });
		outside = changed.filter((f) => !inTouches(f));
		touchesMatched = outside.length === 0;
		if (status === "done" && !head.startsWith(r.head)) {
			status = "failed";
			message = `the result's head ${r.head} is not the worktree HEAD ${head.slice(0, 12)}`;
		} else if (status === "done" && outside.length) {
			const split = splitOutside(outside, ctx.profile, ctx.siblings ?? []);
			const collides = split.blockers.some((b) => b.sibling);
			const blocked =
				split.blockers.length > 0 &&
				(collides ||
					((await ctx.decideTouches?.(split.blockers.map((b) => b.file))) ??
						"park") === "park");
			if (blocked) {
				status = "parked";
				message = `touched files outside its Touches: ${describeBlockers(split.blockers)}`;
			} else ripples = split.ripples;
		}
	}
	const dup = await withLock(
		ctx.dir,
		async () => {
			const prior = applied(ctx, key);
			if (prior) return prior;
			appendRow(ctx.dir, {
				child: key,
				attempt: ctx.attempt,
				stage: "result",
				status,
				tokens: ctx.tokens,
				touchesMatched,
				...(ripples.length ? { ripples } : {}),
				model: { requested: ctx.requestedModel },
				data: {
					message,
					outside,
					evidence: outcome.ok ? outcome.result.evidence : undefined,
					head,
					...(spec ? { spec } : {}),
				},
			});
			return undefined;
		},
		{ name: `apply-${key}.lock`, pollMs: 200, timeoutMs: 60_000 },
	);
	if (dup) return dup;
	if (status === "parked")
		await ctx.onPark?.({ question: message, attempt: ctx.attempt });
	// The row is the record; a tracker outage must not undo it or stop the caller's loop.
	await ctx.tracker
		.comment(key, `Attempt ${ctx.attempt}: ${status}.\n\n${message}`)
		.catch((e: unknown) =>
			console.error(
				`${key}: tracker comment not posted: ${(e as Error).message}`,
			),
		);
	return { status, duplicate: false, outside, message };
}
