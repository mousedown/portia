import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fill } from "../brief/render";
import { accountsOf, pickAccount } from "../core/accounts";
import { childBranch, integrationBranch } from "../core/branches";
import type { Profile } from "../core/config";
import { type Exec, isDryRun, must } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import { appendRow } from "../core/runlog";
import { deriveStates, scheduleOf } from "../core/state";
import type { ParentPlan, RunRow } from "../core/types";
import { childNext, type OpenClaim } from "../drive/steps";
import { withLock } from "../gate/lock";
import { assertionCount, scenarioProblems } from "../gate/specs";
import { LAND_LOCK } from "../land/integration";
import { repoPath } from "../plan/paths";
import {
	collect,
	readRecord,
	running,
	startWorker,
	type WorkerRecord,
	workerPaths,
} from "../worker/detached";

const TEMPLATE = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"skills/portia/amend-brief.md",
);

/** The amendment worker's files sit apart from the child's, so neither overwrites the other's. */
export const amendDir = (dir: string) => {
	const d = join(dir, "amend");
	mkdirSync(d, { recursive: true });
	return d;
};

export interface AmendCtx {
	exec: Exec;
	profile: Profile;
	repoRoot: string;
	dir: string;
	plan: ParentPlan;
	rows: RunRow[];
}

/** The open claim `key` parked on, with the attempt it parked at; refuses when there is none. */
export function openClaim(
	ctx: Pick<AmendCtx, "plan" | "rows" | "profile">,
	key: string,
): { attempt: number; claim: OpenClaim } {
	const state = deriveStates(ctx.plan, ctx.rows, scheduleOf(ctx.profile)).get(
		key,
	);
	const n = childNext(ctx.rows, key, state);
	if (n.next !== "amend")
		throw new PortiaProblem(
			`${key} has no open claim that its acceptance spec cannot pass`,
		);
	return { attempt: n.attempt, claim: n.claim };
}

/** The amendment's last row of `status` for the claim `key` parked on at `attempt`. */
const lastAmend = (
	rows: RunRow[],
	key: string,
	attempt: number,
	status?: string,
) =>
	rows
		.filter(
			(r) =>
				r.child === key &&
				r.stage === "amend" &&
				r.attempt === attempt &&
				(!status || r.status === status),
		)
		.at(-1);

const str = (v: unknown) => (typeof v === "string" ? v : "");
const amendBranch = (p: Profile, key: string) => `${childBranch(p, key)}-spec`;
const amendWorktree = (p: Profile, key: string) =>
	join(p.worktreesDir, p.repo, `${key}-spec`);
/** A recorded diff is kept to this many characters. */
const DIFF_MAX = 20_000;

/**
 * `portia amend start`: makes a worktree on `<prefix>/<KEY>-spec` at the integration tip and
 * starts a detached amendment worker on it, whose brief names the spec, the assertion and
 * the evidence, and lets it change that spec alone. `note` is a review's finding on an
 * earlier try. Records an `amend` row `started` on the attempt the child parked at.
 */
export async function amendStart(
	ctx: AmendCtx,
	key: string,
	note = "",
): Promise<WorkerRecord | undefined> {
	const { exec, profile: p, plan, rows } = ctx;
	const { attempt, claim } = openClaim(ctx, key);
	const c = plan.children.find((x) => x.key === key);
	if (!c) throw new PortiaProblem(`${key} is not a child of ${plan.key}`);
	const dir = amendDir(ctx.dir);
	const last = readRecord(dir, key);
	if (last && running(last))
		throw new PortiaProblem(
			`${key}'s amendment worker already runs as pid ${last.pid}; run portia amend wait`,
		);
	const tries = rows.filter(
		(r) =>
			r.child === key &&
			r.stage === "amend" &&
			r.attempt === attempt &&
			r.status === "started",
	).length;
	const childHead = str(
		rows
			.filter(
				(r) => r.child === key && r.stage === "result" && r.attempt === attempt,
			)
			.at(-1)?.data?.head,
	);
	const tip = `origin/${integrationBranch(p, plan.key)}`;
	const wt = amendWorktree(p, key);
	const branch = amendBranch(p, key);
	const brief = (resultFile: string) =>
		fill(readFileSync(TEMPLATE, "utf8"), {
			parent: plan.key,
			child: key,
			summary: c.summary,
			worktree: wt,
			branch,
			path: claim.path,
			scenario: claim.scenario,
			scenarioText:
				plan.scenarios.find((s) => s.id === claim.scenario)?.text ?? "",
			assertion: claim.assertion,
			evidence: claim.evidence,
			childHead: childHead || childBranch(p, key),
			note: note ? `\n## The review of the last try\n\n${note}\n` : "",
			resultFile,
		});
	if (isDryRun()) {
		console.error(
			`[dry-run] would start an amendment worker for ${key} in ${wt}`,
		);
		return undefined;
	}
	await must(exec, "git", ["fetch", "origin", integrationBranch(p, plan.key)], {
		cwd: ctx.repoRoot,
	});
	// A fresh worktree on the tip each try: an earlier try's commits are its review's to judge.
	if (existsSync(wt))
		await exec("git", ["worktree", "remove", "--force", wt], {
			cwd: ctx.repoRoot,
		});
	await exec("git", ["worktree", "prune"], { cwd: ctx.repoRoot });
	await must(exec, "git", ["worktree", "add", "-B", branch, wt, tip], {
		cwd: ctx.repoRoot,
	});
	const base = (
		await must(exec, "git", ["rev-parse", "HEAD"], { cwd: wt })
	).trim();
	const account = pickAccount(accountsOf(p.workers));
	const rec = startWorker({
		dir,
		key,
		attempt: tries + 1,
		role: "amend",
		model: p.models.high,
		worktree: wt,
		brief: brief(workerPaths(dir, key, tries + 1).result),
		workers: p.workers,
		denyRules: p.denyRules,
		account,
	});
	appendRow(ctx.dir, {
		child: key,
		attempt,
		stage: "amend",
		status: "started",
		data: {
			spec: claim.path,
			scenario: claim.scenario,
			worktree: wt,
			branch,
			base,
			try: tries + 1,
			pid: rec.pid,
			...(note ? { note } : {}),
		},
	});
	return rec;
}

/**
 * Why an amendment from `base` to HEAD in `wt` may not land, one line each: a file other
 * than the spec changed, the scenario is no longer titled or is skipped or focused, or it
 * asserts less than it did. Empty when it may.
 */
export async function amendmentProblems(
	exec: Exec,
	p: Profile,
	wt: string,
	base: string,
	claim: Pick<OpenClaim, "path" | "scenario">,
): Promise<string[]> {
	const spec = repoPath(claim.path, p.packageDir, wt);
	const changed = (
		await must(exec, "git", ["diff", "--name-only", base, "HEAD"], { cwd: wt })
	)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const out: string[] = [];
	if (!changed.includes(spec)) out.push(`it does not change ${spec}`);
	for (const f of changed.filter((f) => f !== spec))
		out.push(`it changes ${f}, outside the spec it amends`);
	out.push(
		...scenarioProblems(wt, [{ id: claim.scenario, path: spec }]).map(
			(l) => `the amended ${l}`,
		),
	);
	const before = await exec("git", ["show", `${base}:${spec}`], { cwd: wt });
	const file = join(wt, spec);
	if (before.code === 0 && existsSync(file)) {
		const was = assertionCount(before.stdout, claim.scenario);
		const now = assertionCount(readFileSync(file, "utf8"), claim.scenario);
		if (now < was)
			out.push(
				`${claim.scenario} makes ${now} assertions where it made ${was}: every clause stays asserted`,
			);
	}
	return out;
}

const diffOf = async (exec: Exec, wt: string, base: string) =>
	(await must(exec, "git", ["diff", base, "HEAD"], { cwd: wt })).slice(
		0,
		DIFF_MAX,
	);

export type AmendWait =
	| { status: "done"; head: string; diff: string }
	| { status: "failed"; reason: string };

/**
 * `portia amend wait`: waits for the amendment worker, then records an `amend` row: `done`
 * with its head and diff when it finished done and the amendment changes only the spec and
 * keeps every assertion of the scenario, else `failed` with the reason.
 */
export async function amendWait(
	ctx: AmendCtx,
	key: string,
	probeCtx: { stallMin: number; limitCooldownMin?: number },
	pollMs: number,
): Promise<AmendWait> {
	const { exec, profile: p, rows } = ctx;
	const { attempt, claim } = openClaim(ctx, key);
	const started = lastAmend(rows, key, attempt, "started");
	const rec = readRecord(amendDir(ctx.dir), key);
	if (!started || !rec || rec.attempt !== Number(started.data?.try))
		throw new PortiaProblem(
			`${key} has no amendment worker for its claim; run portia amend start`,
		);
	let done = await collect(rec, { exec, ...probeCtx });
	while (!done) {
		await new Promise((r) => setTimeout(r, pollMs));
		done = await collect(rec, { exec, ...probeCtx });
	}
	const { outcome, tokens } = done;
	const base = str(started.data?.base);
	let out: AmendWait;
	if (!outcome.ok) out = { status: "failed", reason: outcome.error };
	else if (outcome.result.status !== "done")
		out = {
			status: "failed",
			reason:
				outcome.result.reason ??
				outcome.result.question ??
				"the amendment worker did not finish done",
		};
	else {
		const problems = await amendmentProblems(
			exec,
			p,
			rec.worktree,
			base,
			claim,
		);
		const head = (
			await must(exec, "git", ["rev-parse", "HEAD"], { cwd: rec.worktree })
		).trim();
		out = problems.length
			? { status: "failed", reason: problems.join("\n") }
			: { status: "done", head, diff: await diffOf(exec, rec.worktree, base) };
	}
	appendRow(ctx.dir, {
		child: key,
		attempt,
		stage: "amend",
		status: out.status,
		tokens,
		data: {
			spec: claim.path,
			...(out.status === "done"
				? { head: out.head, diff: out.diff }
				: { reason: out.reason }),
		},
	});
	return out;
}

/**
 * `portia amend land`: once the amendment has a specs sign-off for its head, rebases it onto
 * the integration tip under land.lock, checks it again, pushes it there and records an `amend`
 * row `landed` with the commit and the diff. Drive then redispatches the child onto it.
 */
export async function amendLand(
	ctx: AmendCtx,
	key: string,
): Promise<{ commit: string; onto: string; diff: string }> {
	const { exec, profile: p, plan, rows } = ctx;
	const { attempt, claim } = openClaim(ctx, key);
	const done = lastAmend(rows, key, attempt);
	if (done?.status !== "done")
		throw new PortiaProblem(
			`${key}'s amendment has not finished done${done ? ` (it is ${done.status})` : ""}; run portia amend start, then portia amend wait`,
		);
	const head = str(done.data?.head);
	const signed = rows
		.filter(
			(r) =>
				r.child === key &&
				r.stage === "signoff" &&
				r.data?.amends === claim.path &&
				r.data?.commit === head &&
				r.at >= done.at,
		)
		.at(-1);
	if (signed?.status !== "approved")
		throw new PortiaProblem(
			signed
				? `the amendment of ${claim.path} was not signed off; run portia amend start with the review's notes`
				: `the amendment of ${claim.path} waits for its sign-off: portia signoff specs ${plan.key} --amend ${key}`,
		);
	const started = lastAmend(rows, key, attempt, "started");
	const wt = str(started?.data?.worktree) || amendWorktree(p, key);
	const branch = integrationBranch(p, plan.key);
	const landed = await withLock(
		ctx.dir,
		async () => {
			await must(exec, "git", ["fetch", "origin", branch], { cwd: wt });
			const onto = (
				await must(exec, "git", ["rev-parse", `origin/${branch}`], { cwd: wt })
			).trim();
			const now = (
				await must(exec, "git", ["rev-parse", "HEAD"], { cwd: wt })
			).trim();
			if (now !== head)
				throw new PortiaProblem(
					`the amendment worktree ${wt} is at ${now.slice(0, 12)}, not the signed-off ${head.slice(0, 12)}`,
				);
			if ((await exec("git", ["rebase", onto], { cwd: wt })).code !== 0) {
				await exec("git", ["rebase", "--abort"], { cwd: wt });
				throw new PortiaProblem(
					`the amendment of ${claim.path} conflicts with ${branch}; run portia amend start again`,
				);
			}
			const problems = await amendmentProblems(exec, p, wt, onto, claim);
			if (problems.length)
				throw new PortiaProblem(
					`the amendment of ${claim.path}, rebased onto ${branch}: ${problems.join("; ")}`,
				);
			await must(exec, "git", ["push", "origin", `HEAD:refs/heads/${branch}`], {
				cwd: wt,
			});
			const commit = (
				await must(exec, "git", ["rev-parse", "HEAD"], { cwd: wt })
			).trim();
			return { commit, onto, diff: await diffOf(exec, wt, onto) };
		},
		{ name: LAND_LOCK },
	);
	appendRow(ctx.dir, {
		child: key,
		attempt,
		stage: "amend",
		status: "landed",
		data: {
			spec: claim.path,
			head,
			commit: landed.commit,
			onto: landed.onto,
			diff: landed.diff,
		},
	});
	// Best effort: the worktree's work is on the integration branch now.
	await exec("git", ["worktree", "remove", "--force", wt], {
		cwd: ctx.repoRoot,
	});
	await exec("git", ["branch", "-D", amendBranch(p, key)], {
		cwd: ctx.repoRoot,
	});
	return landed;
}
