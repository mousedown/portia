import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "../core/atomic";
import { childBranch, integrationBranch } from "../core/branches";
import { isDryRun, must } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import { appendRow, readRows } from "../core/runlog";
import type { ChildPlan, ParentPlan } from "../core/types";
import { readEnv } from "../env/env";
import { lockHolder, withLock } from "../gate/lock";
import { reviewChild, reviewOutcome } from "../gate/review";
import { type GateReport, gateVars } from "../gate/run";
import { secretStep } from "../gate/secrets";
import type { Tracker } from "../plan/tracker";
import { LAND_LOCK, type LandCtx, prNumber } from "./integration";

export type LandOutcome =
	/** `pr` is absent for a direct landing (profile `directLand`): there is no per-child PR. */
	| { status: "landed"; pr?: number; sha: string }
	| {
			status: "parked" | "failed";
			reason: string;
			/** Set when the child review blocked the land: its findings, or its own error. */
			review?: "findings" | "error";
			/** Set when CI or GitHub failed the land, not the child's code: land again, never redispatch. */
			infra?: true;
	  };

export const prTitle = (plan: ParentPlan, c: ChildPlan) =>
	`feat(${plan.scope}): ${plan.key} ${c.key} ${c.summary}`.slice(0, 120);

const FAILING = new Set(["fail", "cancel"]);

interface Check {
	name: string;
	bucket: string;
}

/** One entry of a PR's `statusCheckRollup`: a CheckRun (name, status, conclusion) or a StatusContext (context, state). */
export interface RollupEntry {
	__typename?: string;
	name?: string;
	context?: string;
	workflowName?: string;
	status?: string;
	conclusion?: string;
	state?: string;
	startedAt?: string;
}

/**
 * The bucket `gh pr checks` puts a rollup entry in. A StatusContext has a state; a CheckRun
 * has a status and, once completed, a conclusion. Anything unfinished or unknown is pending.
 */
export function bucketOf(e: RollupEntry): string {
	const state = (
		e.state ||
		(e.status === "COMPLETED" ? e.conclusion : e.status) ||
		""
	).toUpperCase();
	switch (state) {
		case "SUCCESS":
			return "pass";
		case "SKIPPED":
		case "NEUTRAL":
			return "skipping";
		case "ERROR":
		case "FAILURE":
		case "TIMED_OUT":
		case "ACTION_REQUIRED":
		case "STARTUP_FAILURE":
			return "fail";
		case "CANCELLED":
			return "cancel";
		default:
			return "pending";
	}
}

/** The checks of a rollup as `gh pr checks` lists them: a check that ran again counts only by its latest run. */
export function rollupChecks(entries: RollupEntry[]): Check[] {
	const latest = [...entries].sort((a, b) =>
		(b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
	);
	const seen = new Set<string>();
	const checks: Check[] = [];
	for (const e of latest) {
		const id = e.context
			? `status ${e.context}`
			: `run ${e.name ?? ""}/${e.workflowName ?? ""}`;
		if (seen.has(id)) continue;
		seen.add(id);
		checks.push({ name: e.name || e.context || "", bucket: bucketOf(e) });
	}
	return checks;
}

/** Unless the profile's ciWaitMs is shorter, checks may take this long to register even with no CI run seen. */
export const REGISTER_GRACE_MS = 5 * 60_000;

/** How long the landed transition may take before the land gives up on it; `portia resume` tries again. */
export const TRACKER_TIMEOUT_MS = 60_000;

/**
 * Whether a workflow run for this head is queued or in progress. Unknown (gh failed,
 * printed something unreadable, or listed no run for this head at all, as with CI outside
 * GitHub Actions) counts as active, so only finished Actions runs ever fail a land early.
 */
async function ciRunActive(
	ctx: LandCtx,
	branch: string,
	sha: string,
	cwd: string,
): Promise<boolean> {
	const r = await ctx.exec(
		"gh",
		[
			"run",
			"list",
			"--branch",
			branch,
			"--json",
			"status,headSha",
			"--limit",
			"50",
		],
		{ cwd },
	);
	if (r.code !== 0) return true;
	try {
		const runs = JSON.parse(r.stdout || "[]") as {
			status: string;
			headSha: string;
		}[];
		const forHead = runs.filter((x) => x.headSha === sha);
		return (
			forHead.length === 0 || forHead.some((x) => x.status !== "completed")
		);
	} catch {
		return true;
	}
}

/**
 * The PR's head commit and its check rollup in one call, so the checks read always belong to
 * the head read with them.
 */
async function prChecks(
	ctx: LandCtx,
	pr: number,
	cwd: string,
): Promise<{ sha: string; checks: Check[] } | { error: string }> {
	const r = await ctx.exec(
		"gh",
		["pr", "view", String(pr), "--json", "headRefOid,statusCheckRollup"],
		{ cwd },
	);
	try {
		const v = JSON.parse(r.stdout) as {
			headRefOid?: string;
			statusCheckRollup?: RollupEntry[] | null;
		};
		if (r.code === 0 && v.headRefOid)
			return {
				sha: v.headRefOid,
				checks: rollupChecks(v.statusCheckRollup ?? []),
			};
	} catch {}
	return {
		error: (
			r.stderr.trim() || `unreadable PR from gh pr view (exit ${r.code})`
		).slice(0, 300),
	};
}

/** Wait `ms`, or less if `signal` aborts first. */
const pause = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((res) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			res();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});

/**
 * Poll the PR's checks without holding any lock. Checks count only once GitHub reports the
 * PR's head as the gated sha, so a rollup left over from an earlier head is never trusted.
 * Returns an outcome only on failure.
 * Fails if no checks register within the profile's `ciWaitMs`, if any check fails or is
 * cancelled (`skipping` counts as a pass), or if something is still pending after
 * `checksTimeoutMin`. A check that only appears when CI ends (an aggregate gate job) makes
 * the wait long, so once the first five minutes have passed a missing check fails early
 * when no CI run for the head is queued or in progress any more.
 * A non-empty `profile.ciChecks` narrows all of this to the named checks: each must
 * register and finish, and every other check is ignored.
 * A check that never registers or never finishes is CI's failure, not the child's, so it is
 * marked `infra`. Once `signal` aborts, the wait stops and returns nothing.
 */
async function waitForChecks(
	ctx: LandCtx,
	pr: number,
	cwd: string,
	head: { branch: string; sha: string },
	signal?: AbortSignal,
): Promise<LandOutcome | undefined> {
	if (isDryRun()) {
		console.error(`[dry-run] skip CI wait for PR #${pr}`);
		return undefined;
	}
	if (ctx.profile.ci === false) return undefined;
	const pollMs = ctx.checksPollMs ?? 10_000;
	const waitMs = ctx.checksWaitMs ?? ctx.profile.ciWaitMs;
	const timeoutMin = ctx.profile.checksTimeoutMin;
	const listed = ctx.profile.ciChecks;
	const start = Date.now();
	const registerBy = start + waitMs;
	const graceBy =
		start + Math.min(waitMs, ctx.checksGraceMs ?? REGISTER_GRACE_MS);
	let pendingBy: number | undefined;
	let lastError = "";
	for (;;) {
		if (signal?.aborted) return undefined;
		let checks: Check[] = [];
		const atHead = await prChecks(ctx, pr, cwd);
		if ("error" in atHead) lastError = atHead.error;
		else if (atHead.sha !== head.sha)
			lastError = `PR #${pr}'s head is ${atHead.sha}, not ${head.sha}`;
		else {
			checks = atHead.checks;
			lastError = "";
		}
		const detail = lastError ? ` (last gh error: ${lastError})` : "";
		const relevant = listed.length
			? checks.filter((c) => listed.includes(c.name))
			: checks;
		const failing = relevant.filter((c) => FAILING.has(c.bucket));
		if (failing.length)
			return {
				status: "failed",
				reason: `CI failed on PR #${pr}: ${failing.map((c) => c.name).join(", ")}`,
			};
		const missing = listed.filter((n) => !checks.some((c) => c.name === n));
		if (relevant.length > 0 && missing.length === 0) {
			pendingBy ??= Date.now() + timeoutMin * 60_000;
			if (!relevant.some((c) => c.bucket === "pending")) return undefined;
		}
		if (pendingBy === undefined) {
			const now = Date.now();
			const ended =
				now < registerBy &&
				now >= graceBy &&
				!(await ciRunActive(ctx, head.branch, head.sha, cwd));
			if (now >= registerBy || ended) {
				const within = ended ? "before CI finished" : `within ${waitMs}ms`;
				return {
					status: "failed",
					reason: missing.length
						? `CI check ${missing.join(", ")} never appeared on PR #${pr} ${within}${detail}`
						: `no CI checks appeared on PR #${pr} ${within}${detail}`,
					infra: true,
				};
			}
		} else if (Date.now() >= pendingBy)
			return {
				status: "failed",
				reason: `CI on PR #${pr} still pending after ${timeoutMin} min${detail}`,
				infra: true,
			};
		await pause(pollMs, signal);
	}
}

/**
 * A landing whose head or integration tip moved after its gate starts over this many times,
 * then makes one last attempt under land.lock; if its own head still moves, it parks.
 */
export const MAX_REGATES = 5;

/** The commits a landing was gated at: the child's head and the integration tip it was rebased onto. */
interface Gated {
	pr: number;
	sha: string;
	onto: string;
}
type Regate = { regate: string };

const revParse = async (ctx: LandCtx, ref: string, cwd: string) =>
	(await must(ctx.exec, "git", ["rev-parse", ref], { cwd })).trim();

async function remoteTips(
	ctx: LandCtx,
	cwd: string,
	branches: string[],
): Promise<Map<string, string>> {
	const out = await must(
		ctx.exec,
		"git",
		["ls-remote", "origin", ...branches.map((b) => `refs/heads/${b}`)],
		{ cwd },
	);
	const tips = new Map<string, string>();
	for (const line of out.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (sha && ref) tips.set(ref.replace(/^refs\/heads\//, ""), sha);
	}
	return tips;
}

/**
 * Under land.lock, just before the merge: whether the child still stands at the commit its
 * gate passed. A commit pushed on top of it is taken into the worktree and gated; a rewritten
 * branch fails. With `landOnGatedTip`, an integration tip that moved also means a re-gate.
 */
async function checkPinned(
	ctx: LandCtx,
	cwd: string,
	base: string,
	branch: string,
	gated: Gated,
): Promise<LandOutcome | Regate | undefined> {
	const { exec } = ctx;
	const tips = await remoteTips(ctx, cwd, [branch, base]);
	const head = tips.get(branch);
	if (head !== gated.sha) {
		// Fetched into FETCH_HEAD only: origin/<branch> is the push's lease, and must not
		// move to a head that is refused here.
		const adopted =
			head !== undefined &&
			(
				await exec(
					"git",
					["fetch", "--refmap=", "origin", `refs/heads/${branch}`],
					{ cwd },
				)
			).code === 0 &&
			(await revParse(ctx, "HEAD", cwd)) === gated.sha &&
			(
				await exec("git", ["merge-base", "--is-ancestor", gated.sha, head], {
					cwd,
				})
			).code === 0 &&
			(await exec("git", ["merge", "--ff-only", head], { cwd })).code === 0;
		if (adopted) {
			await must(
				exec,
				"git",
				["update-ref", `refs/remotes/origin/${branch}`, head],
				{ cwd },
			);
			return { regate: `${branch} moved to ${head} after its gate passed` };
		}
		return {
			status: "failed",
			reason: `${branch} changed after its gate passed at ${gated.sha} (now ${head ?? "gone"}); nothing merged`,
		};
	}
	if ((await revParse(ctx, "HEAD", cwd)) !== gated.sha)
		return { regate: `${branch} has new commits in its worktree` };
	if (ctx.profile.landOnGatedTip && tips.get(base) !== gated.onto)
		return {
			regate: `${base} moved from ${gated.onto} to ${tips.get(base)} after the gate`,
		};
	return undefined;
}

/** gh's refusal when the PR's head is no longer the commit the merge was pinned to. */
const HEAD_MOVED = /head branch was modified|head commit|match-head-commit/i;

/**
 * Whether GitHub refused the merge, or only its answer was lost: a merge GitHub applied can
 * still exit non-zero (a dropped connection, a 502), so the PR's own state decides.
 */
async function mergeRefused(
	ctx: LandCtx,
	pr: number,
	cwd: string,
	stderr: string,
): Promise<LandOutcome | undefined> {
	const r = await ctx.exec(
		"gh",
		["pr", "view", String(pr), "--json", "state"],
		{
			cwd,
			timeoutMs: 60_000,
		},
	);
	try {
		if (
			r.code === 0 &&
			(JSON.parse(r.stdout) as { state?: string }).state === "MERGED"
		)
			return undefined;
	} catch {}
	const reason = `merge refused for PR #${pr}: ${stderr.trim()}`;
	return HEAD_MOVED.test(stderr)
		? { status: "failed", reason }
		: { status: "failed", reason, infra: true };
}

const dispatchedAttempt = (dir: string, key: string) =>
	readRows(dir)
		.rows.filter((r) => r.child === key && r.stage === "dispatched")
		.at(-1)?.attempt ?? 0;

/**
 * The landed row, written as soon as the merge is known, before any tracker call. Its
 * `tracker: "pending"` stands until a `tracker` row follows, so `portia resume` can retry a
 * transition a killed or hung land never finished.
 */
function recordLanded(
	dir: string,
	key: string,
	data: Record<string, unknown>,
): void {
	appendRow(dir, {
		child: key,
		attempt: dispatchedAttempt(dir, key),
		stage: "landed",
		status: "landed",
		data: { ...data, tracker: "pending" },
	});
}

/**
 * Move a landed child's ticket, best effort and bounded by `timeoutMs`: the merge stands
 * whatever the tracker does. The outcome is a `tracker` row, with `jiraError` on failure.
 */
export async function transitionLanded(
	dir: string,
	tracker: Pick<Tracker, "transition">,
	key: string,
	state: string,
	timeoutMs = TRACKER_TIMEOUT_MS,
): Promise<void> {
	let jiraError: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			tracker.transition(key, state),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`the tracker did not answer within ${timeoutMs}ms`),
						),
					timeoutMs,
				);
			}),
		]);
	} catch (e) {
		jiraError = e instanceof Error ? e.message : String(e);
	} finally {
		clearTimeout(timer);
	}
	appendRow(dir, {
		child: key,
		attempt: dispatchedAttempt(dir, key),
		stage: "tracker",
		status: jiraError ? "failed" : "transitioned",
		data: { state, ...(jiraError ? { jiraError } : {}) },
	});
}

/**
 * A PR from the child's branch that GitHub already merged into the integration branch: an
 * earlier land merged it, then was killed or never heard back. It is recorded as landed
 * rather than rebased onto a base that already holds it.
 */
async function alreadyMerged(
	ctx: LandCtx,
	key: string,
	base: string,
	branch: string,
): Promise<{ pr: number; sha: string; logged: boolean } | undefined> {
	if (ctx.mergedIn !== undefined)
		return mergedInto(ctx, key, base, ctx.mergedIn);
	const r = await ctx.exec(
		"gh",
		[
			"pr",
			"list",
			"--head",
			branch,
			"--base",
			base,
			"--state",
			"merged",
			"--limit",
			"1",
			"--json",
			"number,headRefOid",
		],
		{ cwd: ctx.repoRoot },
	);
	let m: { number: number; headRefOid?: string } | undefined;
	try {
		m = (JSON.parse(r.stdout || "[]") as (typeof m)[])[0];
	} catch {}
	if (r.code !== 0 || !m) return undefined;
	const logged = readRows(ctx.dir).rows.some(
		(x) => x.child === key && x.stage === "landed",
	);
	return { pr: m.number, sha: m.headRefOid ?? "", logged };
}

/** The named PR as this child's landing, only when it is merged into `base`. */
async function mergedInto(
	ctx: LandCtx,
	key: string,
	base: string,
	pr: number,
): Promise<{ pr: number; sha: string; logged: boolean }> {
	const out = await must(
		ctx.exec,
		"gh",
		["pr", "view", String(pr), "--json", "state,baseRefName,mergeCommit"],
		{ cwd: ctx.repoRoot },
	);
	const m = JSON.parse(out) as {
		state: string;
		baseRefName: string;
		mergeCommit: { oid: string } | null;
	};
	if (m.state !== "MERGED" || m.baseRefName !== base || !m.mergeCommit)
		throw new PortiaProblem(
			`${key}: PR #${pr} is not merged into ${base} (state ${m.state}, base ${m.baseRefName})`,
		);
	const logged = readRows(ctx.dir).rows.some(
		(x) => x.child === key && x.stage === "landed",
	);
	return { pr, sha: m.mergeCommit.oid, logged };
}

/** A rebase an interrupted land left behind would fail the next rebase at once, and park the child on a conflict that is not there. */
async function abortStaleRebase(ctx: LandCtx, cwd: string): Promise<boolean> {
	for (const d of ["rebase-merge", "rebase-apply"]) {
		const p = (
			await must(ctx.exec, "git", ["rev-parse", "--git-path", d], { cwd })
		).trim();
		if (existsSync(isAbsolute(p) ? p : join(cwd, p))) {
			await ctx.exec("git", ["rebase", "--abort"], { cwd });
			return true;
		}
	}
	return false;
}

const passedFile = (dir: string, key: string) =>
	join(dir, `land-gated-${key}.json`);
function readPassed(dir: string, key: string): string[] {
	try {
		return JSON.parse(readFileSync(passedFile(dir, key), "utf8")) as string[];
	} catch {
		return [];
	}
}

/**
 * The exit gate on the rebased head (R6). A pass is remembered by the tree it ran on, the
 * integration tip under it and `ctx.gateInputs` (everything else the gate reads), and only
 * with a clean worktree, so landing the same tree on the same tip again (after CI or GitHub
 * failed the last try) does not run the gate twice. Only passes `land` ran itself count; a
 * worker's own `portia gate exit` never does.
 */
async function exitGate(
	ctx: LandCtx,
	key: string,
	cwd: string,
	onto: string,
	landed: ReadonlySet<string>,
): Promise<GateReport> {
	const inputs = ctx.gateInputs?.(key, landed);
	const clean =
		inputs !== undefined &&
		(await must(ctx.exec, "git", ["status", "--porcelain"], { cwd })).trim() ===
			"";
	const id = clean
		? `${await revParse(ctx, "HEAD^{tree}", cwd)} ${onto} ${inputs}`
		: undefined;
	if (id && readPassed(ctx.dir, key).includes(id)) {
		console.error(
			`${key}: the exit gate already passed this tree on ${onto}; not running it again`,
		);
		return { kind: "exit", ok: true, steps: [] };
	}
	// Pinned to `onto`: a sibling's fetch may move origin/<base> while this gate runs.
	const report = await ctx.gate(key, onto, landed);
	if (report.ok && id && !isDryRun())
		writeFileAtomic(
			passedFile(ctx.dir, key),
			JSON.stringify(
				[...readPassed(ctx.dir, key).filter((x) => x !== id), id].slice(-20),
			),
		);
	return report;
}

/** The patch id of `onto..sha`, which stays the same when the same change is rebased onto a new tip. */
async function patchId(
	ctx: LandCtx,
	cwd: string,
	onto: string,
	sha: string,
): Promise<string | undefined> {
	const diff = await must(ctx.exec, "git", ["diff", `${onto}..${sha}`], {
		cwd,
	});
	if (!diff.trim()) return undefined;
	const r = await ctx.exec("git", ["patch-id", "--stable"], {
		cwd,
		input: diff,
	});
	return r.code === 0
		? r.stdout.trim().split(/\s+/)[0] || undefined
		: undefined;
}

const childLandLock = (key: string) => `land-${key}.lock`;

/** An exit gate that failed on the rebased head, with the tail of its first failing step. */
function gateFailed(report: GateReport): LandOutcome {
	const failed = report.steps.filter((s) => !s.ok);
	const out = failed[0]?.tail.trim().split("\n").slice(-20).join("\n");
	return {
		status: "failed",
		reason: `exit gate failed on the rebased head (R6): ${failed
			.map((s) => s.name)
			.join(", ")}${out ? `\n${out.slice(-2_000)}` : ""}`,
	};
}

/** The pid of a `portia land` of this child that is still running, if there is one. */
export const landRunning = (dir: string, key: string): number | undefined =>
	lockHolder(dir, childLandLock(key));

/** One land per child at a time: a second one refuses at once rather than gating and pushing in the same worktree. */
export async function land(key: string, ctx: LandCtx): Promise<LandOutcome> {
	if (!ctx.plan.children.some((x) => x.key === key))
		throw new PortiaProblem(`${key} is not a child of ${ctx.plan.key}`);
	let entered = false;
	try {
		return await withLock(
			ctx.dir,
			() => {
				entered = true;
				return landAlone(key, ctx);
			},
			{ name: childLandLock(key), timeoutMs: 0, pollMs: 1 },
		);
	} catch (e) {
		if (entered || !(e instanceof PortiaProblem)) throw e;
		const pid = landRunning(ctx.dir, key);
		throw new PortiaProblem(
			`a land of ${key} is already running${pid ? ` (pid ${pid})` : ""}; wait for it rather than starting another`,
		);
	}
}

/**
 * Whether this epic's children land by a direct push (profile `directLand`): it has at most
 * `maxChildren` children and none is a design child.
 */
export const landsDirect = (ctx: Pick<LandCtx, "profile" | "plan">) => {
	const d = ctx.profile.directLand;
	return (
		!!d &&
		ctx.plan.children.length <= d.maxChildren &&
		!ctx.plan.children.some((c) => c.design)
	);
};

/** The trailer a direct landing's commit carries, so a land that died after its push finds it. */
const directTrailer = (key: string) => `Portia-Child: ${key}`;

/** The integration branch's commit that directly landed `key`, if one did. */
async function directlyLanded(
	ctx: LandCtx,
	cwd: string,
	base: string,
	key: string,
): Promise<string | undefined> {
	const r = await ctx.exec(
		"git",
		[
			"log",
			"--first-parent",
			"--format=%H",
			`--grep=^${directTrailer(key)}$`,
			`origin/${base}`,
		],
		{ cwd },
	);
	return r.code === 0
		? r.stdout.split("\n")[0]?.trim() || undefined
		: undefined;
}

async function landAlone(key: string, ctx: LandCtx): Promise<LandOutcome> {
	const { exec, plan, dir } = ctx;
	const c = plan.children.find((x) => x.key === key) as ChildPlan;
	const base = integrationBranch(ctx.profile, plan.key);
	const branch = childBranch(ctx.profile, key);
	const landedState = ctx.profile.transitions.landed;
	const direct = landsDirect(ctx);
	// A direct epic opens no PR per child, so there is no merged one to look for.
	const prior = direct
		? undefined
		: await alreadyMerged(ctx, key, base, branch);
	if (prior) {
		const { pr, sha, logged } = prior;
		if (!logged && isDryRun())
			console.error(
				`[dry-run] PR #${pr} is already merged; would record ${key} landed`,
			);
		else if (!logged) {
			console.error(
				`${key}: PR #${pr} is already merged into ${base}; recording it landed`,
			);
			recordLanded(dir, key, { pr, sha, source: "github" });
			await transitionLanded(
				dir,
				ctx.tracker,
				key,
				landedState,
				ctx.trackerTimeoutMs,
			);
		}
		return { status: "landed", pr, sha };
	}
	const env = readEnv(dir, key);
	const cwd = env.worktree;
	const lock = { ...ctx.lockOpts, name: LAND_LOCK };
	if (direct) {
		// A land that died after its push and before its landed row: record it, push nothing.
		const found = await withLock(
			dir,
			async () => {
				await must(exec, "git", ["fetch", "origin", base], { cwd });
				return directlyLanded(ctx, cwd, base, key);
			},
			lock,
		);
		if (found) {
			const logged = readRows(dir).rows.some(
				(r) => r.child === key && r.stage === "landed",
			);
			if (!logged && !isDryRun()) {
				console.error(
					`${key}: already pushed onto ${base} as ${found.slice(0, 9)}; recording it landed`,
				);
				recordLanded(dir, key, { sha: found, direct: true, source: "push" });
				await transitionLanded(
					dir,
					ctx.tracker,
					key,
					landedState,
					ctx.trackerTimeoutMs,
				);
			}
			return { status: "landed", sha: found };
		}
	}
	/** Set once the landed row is written; the ticket moves after land.lock is released. */
	let recorded = false;
	/** The patch id of the last diff the child review passed in this land; the same diff is not reviewed twice. */
	let reviewedPatch: string | undefined;
	const review = async (
		onto: string,
		sha: string,
	): Promise<LandOutcome | undefined> => {
		const spec = ctx.profile.review?.child;
		if (!spec) return undefined;
		if (isDryRun()) {
			console.error(`[dry-run] skip the child review of ${key}`);
			return undefined;
		}
		const patch = await patchId(ctx, cwd, onto, sha);
		if (patch && patch === reviewedPatch) {
			console.error(
				`${key}: the child review already passed this diff; not reviewing it again at ${sha}`,
			);
			return undefined;
		}
		const verdict = await reviewChild({
			exec,
			profile: ctx.profile,
			spec,
			dir,
			env,
			child: key,
			parent: plan.key,
			base: onto,
			head: sha,
		});
		const blocked = reviewOutcome(verdict, spec, sha);
		if (!blocked) reviewedPatch = patch;
		return blocked;
	};
	/**
	 * A direct landing: the same exit gate and child review on the rebased head, then, under
	 * land.lock, the gated tree as one commit on the tip it was gated on, pushed fast forward
	 * only. A tip that moved since re-gates: nothing lands on code its gate did not run on.
	 */
	const landDirect = async (
		onto: string,
		landed: ReadonlySet<string>,
		sha: string,
	): Promise<LandOutcome | Regate> => {
		const report = await exitGate(ctx, key, cwd, onto, landed);
		if (!report.ok) return gateFailed(report);
		if ((await revParse(ctx, "HEAD", cwd)) !== sha)
			return { regate: `${key}'s worktree moved while its gate ran` };
		const blocked = await review(onto, sha);
		if (blocked) return blocked;
		if (isDryRun()) {
			console.error(
				`[dry-run] would push ${key} onto ${base}, transition and record landed`,
			);
			return { status: "landed", sha };
		}
		return withLock(
			dir,
			async (): Promise<LandOutcome | Regate> => {
				await must(exec, "git", ["fetch", "origin", base], { cwd });
				const tip = await revParse(ctx, `origin/${base}`, cwd);
				if (tip !== onto)
					return {
						regate: `${base} moved from ${onto} to ${tip} during the gate`,
					};
				const tree = await revParse(ctx, `${sha}^{tree}`, cwd);
				const commit = (
					await must(
						exec,
						"git",
						[
							"commit-tree",
							tree,
							"-p",
							onto,
							"-m",
							`${prTitle(plan, c)} [${key}]`,
							"-m",
							`Part of ${plan.key}.\n\nRequirements: ${c.requirements.join(", ") || "spine"}`,
							"-m",
							directTrailer(key),
						],
						{ cwd },
					)
				).trim();
				const pushed = await exec(
					"git",
					["push", "origin", `${commit}:refs/heads/${base}`],
					{ cwd },
				);
				if (pushed.code !== 0)
					return {
						regate: `${base} refused ${key}'s push: ${pushed.stderr.trim().split("\n").at(-1) ?? ""}`,
					};
				recordLanded(dir, key, { sha: commit, gated: sha, onto, direct: true });
				recorded = true;
				return { status: "landed", sha: commit };
			},
			lock,
		);
	};
	const attempt = async (): Promise<LandOutcome | Regate> => {
		// Phase 1, holding only this child's lock: rebase, exit gate (R6), push the gated sha,
		// PR create/find, all in the child's own worktree, so siblings rebase and gate at the
		// same time. Worktrees share origin's remote-tracking refs, so the fetch takes land.lock,
		// and the tip is read under it: a sibling's fetch may move origin/<base> after it. The
		// landed children are read first under the same lock: a sibling merges and writes its
		// landed row under land.lock, so each one read here is in `onto`, and the regression guard does
		// not run a sibling's scenarios on a tip that lacks its code.
		const { onto, landed } = await withLock(
			dir,
			async () => {
				const landed = new Set(
					readRows(dir)
						.rows.filter((r) => r.stage === "landed")
						.map((r) => r.child),
				);
				await must(exec, "git", ["fetch", "origin", base], { cwd });
				return { onto: await revParse(ctx, `origin/${base}`, cwd), landed };
			},
			lock,
		);
		if (await abortStaleRebase(ctx, cwd))
			console.error(`${key}: aborted a rebase an earlier land left unfinished`);
		if ((await exec("git", ["rebase", onto], { cwd })).code !== 0) {
			await exec("git", ["rebase", "--abort"], { cwd });
			return {
				status: "parked",
				reason: `rebasing ${key} onto ${base} conflicts`,
			};
		}
		const sha = await revParse(ctx, "HEAD", cwd);
		// The gate may have been a remembered pass, or skipped the scan; nothing leaves unscanned,
		// by either route.
		const secrets = await secretStep(
			exec,
			cwd,
			ctx.profile,
			{ base: onto, head: sha },
			gateVars(ctx.profile, env.envFile),
		);
		if (!secrets.ok)
			return {
				status: "failed",
				reason: `secret scan refused to push ${branch} at ${sha}:\n${secrets.tail}`,
			};
		if (direct) return landDirect(onto, landed, sha);
		await must(
			exec,
			"git",
			["push", "--force-with-lease", "origin", `${sha}:refs/heads/${branch}`],
			{ cwd },
		);
		const open = JSON.parse(
			(await must(
				exec,
				"gh",
				[
					"pr",
					"list",
					"--head",
					branch,
					"--base",
					base,
					"--state",
					"open",
					"--json",
					"number",
				],
				{ cwd },
			)) || "[]",
		) as { number: number }[];
		const pr =
			open[0]?.number ??
			prNumber(
				await must(
					exec,
					"gh",
					[
						"pr",
						"create",
						"--base",
						base,
						"--head",
						branch,
						"--title",
						prTitle(plan, c),
						"--body",
						`Part of ${plan.key}.\n\nRequirements: ${c.requirements.join(", ") || "spine"}`,
					],
					{ cwd },
				),
			);
		const pushed: Gated = { pr, sha, onto };
		// Phase 2, no lock: the exit gate, the child review and the CI wait, all pinned to `sha`.
		// The gate decides first, then the review, then CI.
		const ci = new AbortController();
		const checking = waitForChecks(ctx, pr, cwd, { branch, sha }, ci.signal);
		// Only so a rejection is never unhandled; it is awaited below.
		checking.catch(() => {});
		const stopCi = <T>(out: T): T => {
			ci.abort();
			return out;
		};
		let report: GateReport;
		try {
			report = await exitGate(ctx, key, cwd, onto, landed);
		} catch (e) {
			ci.abort();
			throw e;
		}
		if (!report.ok) return stopCi(gateFailed(report));
		if ((await revParse(ctx, "HEAD", cwd)) !== sha)
			return stopCi({ regate: `${branch} moved while its gate ran` });
		// Siblings land while this one gates. Without landOnGatedTip that is accepted, as it is
		// during CI; with it, a moved tip re-gates now rather than after review and CI.
		if (ctx.profile.landOnGatedTip) {
			const tip = (await remoteTips(ctx, cwd, [base])).get(base);
			if (tip !== onto)
				return stopCi({
					regate: `${base} moved from ${onto} to ${tip} during the gate`,
				});
		}
		let blocked: LandOutcome | undefined;
		try {
			blocked = await review(onto, sha);
		} catch (e) {
			ci.abort();
			throw e;
		}
		if (blocked) {
			ci.abort();
			return blocked;
		}
		const checks = await checking;
		if (checks) return checks;
		if (isDryRun()) {
			console.error(
				`[dry-run] would merge PR #${pr}, transition and record landed`,
			);
			return { status: "landed", pr, sha };
		}
		// Phase 3, under land.lock again: check the pin, merge, and the landed row.
		return withLock(
			dir,
			async (): Promise<LandOutcome | Regate> => {
				const moved = await checkPinned(ctx, cwd, base, branch, pushed);
				if (moved) return moved;
				const merged = await exec(
					"gh",
					["pr", "merge", String(pr), "--squash", "--match-head-commit", sha],
					{ cwd },
				);
				if (merged.code !== 0) {
					const refused = await mergeRefused(ctx, pr, cwd, merged.stderr);
					if (refused) return refused;
					console.error(
						`gh pr merge exited ${merged.code}, but PR #${pr} is merged; recording it landed`,
					);
				}
				recordLanded(dir, key, { pr, sha, onto });
				recorded = true;
				return { status: "landed", pr, sha };
			},
			lock,
		);
	};
	for (let regates = 0; ; regates++) {
		// The last attempt holds land.lock through CI, so no sibling can move the tip under it.
		const out =
			regates === MAX_REGATES
				? await withLock(dir, attempt, lock)
				: await attempt();
		if (!("regate" in out)) {
			// Outside land.lock: a slow tracker never holds up a sibling's landing.
			if (recorded)
				await transitionLanded(
					dir,
					ctx.tracker,
					key,
					landedState,
					ctx.trackerTimeoutMs,
				);
			return out;
		}
		if (regates === MAX_REGATES)
			return {
				status: "parked",
				reason: `${key} kept changing after its gate (${out.regate}); re-gated ${MAX_REGATES} times, nothing merged`,
			};
		console.error(`re-gating ${key}: ${out.regate}`);
	}
}
