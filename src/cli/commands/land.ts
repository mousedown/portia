import { createHash } from "node:crypto";
import type { Profile } from "../../core/config";
import { isDryRun, realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { runMetrics } from "../../core/metrics";
import { appendRow, nextAttempt, readRows } from "../../core/runlog";
import { scheduleOf } from "../../core/state";
import type { ParentPlan, RunRow } from "../../core/types";
import { designGate } from "../../design/check";
import { envDown, readEnv } from "../../env/env";
import { runGate } from "../../gate/run";
import { touchedFiles } from "../../gate/touched";
import {
	initIntegration,
	type LandCtx,
	land,
	syncMain,
} from "../../land/integration-and-land";
import type { LandOutcome } from "../../land/land";
import { publishLedger } from "../../ledger/publish";
import { ledgerChildren, renderLedger } from "../../ledger/render";
import { notifyPark, notifySpec } from "../../notify/park";
import { childLanes } from "../../plan/check";
import { landedScenarios, ownedForGate } from "../../plan/owned";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

/**
 * What the exit gate at land reads besides the tree, from the run log as it stands: the
 * child's scenarios, its lane, and the regression guard, which grows with every landing. With
 * `landed`, the regression guard counts only those children: the ones whose merge is in the tip being
 * gated, so a sibling that lands after the tip was read is not held against this child.
 */
export function landGateView(
	profile: Profile,
	plan: ParentPlan,
	files: string[],
	rows: RunRow[],
	key: string,
	landed?: ReadonlySet<string>,
) {
	const child = plan.children.find((c) => c.key === key);
	const atTip = landed
		? rows.filter((r) => r.stage !== "landed" || landed.has(r.child))
		: rows;
	return {
		child,
		owned: ownedForGate(plan, child, rows),
		lane: childLanes(plan, files, profile, rows)?.get(key),
		regressionGuard:
			profile.regressionGuard && child ? landedScenarios(plan, atTip) : [],
	};
}

/** The fingerprint `exitGate` keys its passes on, with the tree and the tip. */
export const landGateInputs = (
	profile: Profile,
	view: ReturnType<typeof landGateView>,
) =>
	createHash("sha256")
		.update(JSON.stringify({ profile, ...view }))
		.digest("hex");

export async function landCtx(parent: string): Promise<LandCtx> {
	const { profile, tracker } = await cliContext();
	const { plan, dir, files } = await loadForCli(parent);
	const gateFor = (k: string, landed?: ReadonlySet<string>) =>
		landGateView(profile, plan, files, readRows(dir).rows, k, landed);
	return {
		exec: realExec,
		profile,
		repoRoot: process.cwd(),
		dir,
		plan,
		tracker,
		files,
		lockOpts: { pollMs: 200 },
		gateInputs: (k, landed) => landGateInputs(profile, gateFor(k, landed)),
		gate: async (k, onto, landed) => {
			const env = readEnv(dir, k);
			const touched = await touchedFiles(
				realExec,
				profile,
				env.worktree,
				plan.key,
				onto,
			);
			const { child, owned, lane, regressionGuard } = gateFor(k, landed);
			return runGate("exit", {
				exec: realExec,
				profile,
				dir,
				env,
				parent: plan.key,
				touched,
				designCheck: designGate(child, { exec: realExec, profile, dir, env }),
				...owned,
				regressionGuard,
				lane,
				base: onto,
			});
		},
	};
}

export const integrationCommand: Command = async (args, io) => {
	const [sub, key] = args;
	if (!key || (sub !== "init" && sub !== "sync"))
		throw new PortiaProblem("usage: portia integration init|sync <PARENT>");
	const ctx = await landCtx(key);
	if (sub === "init") io.out(JSON.stringify(await initIntegration(ctx)));
	else await syncMain(ctx);
	return EXIT.OK;
};

/** Landings again after CI or GitHub failed one; one more such failure parks the child for a person. */
export const MAX_RELANDS = 2;

/**
 * An infrastructure failure (`infra`) is landed again rather than redispatched, but only
 * MAX_RELANDS times in a row for one attempt; the next one parks, so a CI that stays broken
 * reaches a person instead of looping.
 */
export function capRelands(
	dir: string,
	key: string,
	out: LandOutcome,
): LandOutcome {
	if (out.status === "landed" || !out.infra) return out;
	let before = 0;
	for (const r of readRows(dir)
		.rows.filter((x) => x.child === key)
		.reverse()) {
		if (r.stage === "dispatched") break;
		if (r.stage !== "land") continue;
		if (r.data?.infra !== true) break;
		before++;
	}
	if (before < MAX_RELANDS) return out;
	return {
		status: "parked",
		reason: `${out.reason}\nCI or GitHub failed ${before + 1} landings of ${key} in a row; a person should look before it lands again`,
	};
}

/**
 * A failed or parked land is written to the run log, so a retry's brief and `decide
 * failure` see the failure and resume routes the child as failed or parked, not to land.
 */
export function recordLandFailure(
	dir: string,
	key: string,
	out: LandOutcome,
): void {
	if (out.status === "landed" || isDryRun()) return;
	appendRow(dir, {
		child: key,
		attempt: Math.max(0, nextAttempt(readRows(dir).rows, key) - 1),
		stage: "land",
		status: out.status,
		data: {
			reason: out.reason,
			...(out.review ? { review: out.review } : {}),
			...(out.infra ? { infra: true } : {}),
		},
	});
}

/**
 * After a land: record a failure, or take the landed child's env down. A land the child
 * review blocked republishes the ledger, which is otherwise refreshed only after a landing,
 * so the epic PR shows the verdict now. Best effort: the land's outcome stands either way.
 */
export async function afterLand(
	ctx: LandCtx,
	key: string,
	parent: string,
	out: LandOutcome,
): Promise<void> {
	recordLandFailure(ctx.dir, key, out);
	if (out.status !== "landed" && out.review && !isDryRun()) {
		await publishLedger(ctx.exec, ctx.dir, () => {
			const rows = readRows(ctx.dir).rows;
			const lanes =
				ctx.files && childLanes(ctx.plan, ctx.files, ctx.profile, rows);
			return renderLedger(
				ctx.plan,
				ledgerChildren(ctx.plan, rows, ctx.dir, lanes, scheduleOf(ctx.profile)),
				runMetrics(ctx.plan.children, rows),
			);
		}).catch((e: unknown) =>
			console.error(`ledger not republished: ${(e as Error).message}`),
		);
	}
	// A dry run merged nothing, so the child's env stays up.
	if (out.status === "landed" && !isDryRun()) await envDown(key, parent, ctx);
}

export const landCommand: Command = async (args, io) => {
	const key = args[0]?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent)
		throw new PortiaProblem(
			"usage: portia land <KEY> --parent <PARENT> [--merged-in <PR>]",
		);
	const mergedIn = flag(args, "--merged-in");
	if (mergedIn !== undefined && !/^\d+$/.test(mergedIn))
		throw new PortiaProblem("--merged-in takes a PR number");
	const ctx = {
		...(await landCtx(parent)),
		...(mergedIn ? { mergedIn: Number(mergedIn) } : {}),
	};
	const out = capRelands(ctx.dir, key, await land(key, ctx));
	await afterLand(ctx, key, parent, out);
	if (out.status === "parked")
		await notifyPark(
			{
				parent,
				child: key,
				question: out.reason,
				attempt: Math.max(0, nextAttempt(readRows(ctx.dir).rows, key) - 1),
			},
			{ exec: ctx.exec, notify: notifySpec(ctx.profile) },
		);
	io.out(JSON.stringify(out));
	return out.status === "landed" ? EXIT.OK : EXIT.PROBLEM;
};
