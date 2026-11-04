import { readFileSync } from "node:fs";
import { approvedGlobs } from "../../core/approvals";
import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { readRows } from "../../core/runlog";
import type { ParentPlan } from "../../core/types";
import { decide } from "../../decide/decide";
import { jevFromProfile } from "../../decide/jev";
import { notifyPark, notifySpec } from "../../notify/park";
import { ownedScenarios } from "../../plan/owned";
import { type Applied, applyOutcome } from "../../result/apply";
import { type ParseOutcome, parseResult } from "../../result/parse";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

export function parseTokens(value: string | undefined): number {
	const n =
		value === undefined || value.trim() === "" ? Number.NaN : Number(value);
	if (!Number.isInteger(n) || n < 0)
		throw new PortiaProblem(
			"--tokens <n> is required: the total tokens the worker reported",
		);
	return n;
}

export const resultCommand: Command = async (args, io) => {
	const key = args[0]?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	const from = flag(args, "--from");
	if (!key || !parent || !from)
		throw new PortiaProblem(
			"usage: portia result <KEY> --parent <PARENT> --from <file> [--tokens <n>]",
		);
	const tokens = parseTokens(flag(args, "--tokens"));
	const applied = await applyResult(
		key,
		parent,
		parseResult(readFileSync(from, "utf8"), key),
		tokens,
	);
	io.out(JSON.stringify(applied));
	return resultExit(applied);
};

/** A stale outcome belongs to an attempt the run has moved past: exit 10, nothing to act on. */
export const resultExit = (a: Applied & { stale?: boolean }) =>
	a.stale ? EXIT.NOTHING : a.status === "done" ? EXIT.OK : EXIT.PROBLEM;

/**
 * Applies a worker's outcome to its latest dispatched attempt. Given `attempt`, an
 * outcome for any other attempt is stale and applies nothing. `loaded` is a plan the
 * caller has only just loaded; without it the plan is loaded afresh.
 */
export async function applyResult(
	key: string,
	parent: string,
	outcome: ParseOutcome,
	tokens: number,
	attempt?: number,
	loaded?: { plan: ParentPlan; dir: string },
): Promise<Applied & { stale?: boolean }> {
	const { plan, dir } = loaded ?? (await loadForCli(parent));
	const c = plan.children.find((x) => x.key === key);
	if (!c) throw new PortiaProblem(`${key} is not a child of ${parent}`);
	const rows = readRows(dir).rows;
	const dispatched = rows
		.filter((r) => r.child === key && r.stage === "dispatched")
		.at(-1);
	// A sibling that has landed can no longer collide at land: its code is on the base.
	const landed = new Set(
		rows.filter((r) => r.stage === "landed").map((r) => r.child),
	);
	if (!dispatched)
		throw new PortiaProblem(
			`${key} was never dispatched; run portia dispatch first`,
		);
	if (attempt !== undefined && attempt !== dispatched.attempt)
		return {
			status: "failed",
			duplicate: true,
			stale: true,
			outside: [],
			message: `attempt ${attempt} was superseded by attempt ${dispatched.attempt}; nothing applied`,
		};
	const { profile, tracker } = await cliContext();
	return applyOutcome(outcome, key, {
		exec: realExec,
		profile,
		dir,
		parent,
		tracker,
		touches: c.touches,
		owned: ownedScenarios(plan, c),
		siblings: plan.children.filter(
			(x) => x.wave === c.wave && x.key !== key && !landed.has(x.key),
		),
		attempt: dispatched.attempt,
		tokens,
		requestedModel: dispatched.model?.requested ?? "unknown",
		onPark: (p) =>
			notifyPark(
				{ parent, child: key, ...p },
				{ exec: realExec, notify: notifySpec(profile) },
			),
		decideTouches: async (outside) =>
			(
				await decide(
					"touches-mismatch",
					{
						child: key,
						touches: c.touches,
						outside,
						approved: approvedGlobs(dir, key),
					},
					{ profile, dir, jev: jevFromProfile(profile) },
				)
			).answer as "accept" | "park",
	});
}
