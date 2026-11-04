import { join } from "node:path";
import { writeFileAtomic } from "../../core/atomic";
import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { runMetrics } from "../../core/metrics";
import { readRows } from "../../core/runlog";
import { closedOutsideRun, landedKeys, scheduleOf } from "../../core/state";
import { runEpicGate } from "../../gate/epic";
import { integrationWorktree, readEpic } from "../../land/integration";
import { CLOSES, publishLedger } from "../../ledger/publish";
import { ledgerChildren, renderLedger } from "../../ledger/render";
import { childLanes } from "../../plan/check";
import type { Tracker } from "../../plan/tracker";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";

export async function closesLines(
	tracker: Tracker,
	keys: string[],
): Promise<string> {
	if (!tracker.issueRef) return "";
	const refs: string[] = [];
	for (const k of keys) refs.push(`Closes ${await tracker.issueRef(k)}`);
	return refs.join("\n");
}

/** Runs the epic gate; marks the epic PR ready only when everything passes. */
export const epicCommand: Command = async (args, io) => {
	const key = args[0]?.toUpperCase();
	if (!key) throw new PortiaProblem("usage: portia epic <PARENT>");
	const ctx = await cliContext();
	const { profile } = ctx;
	const { plan, dir, files } = await loadForCli(key);
	const rows = readRows(dir).rows;
	const landed = landedKeys(rows);
	// A child closed in the tracker outside the run has nothing to land.
	const closed = new Set(closedOutsideRun(plan, rows));
	const open = plan.children.filter(
		(c) => !landed.has(c.key) && !closed.has(c.key),
	);
	if (open.length)
		throw new PortiaProblem(
			`not every child has landed: ${open.map((c) => c.key).join(", ")}`,
		);
	const report = await runEpicGate({
		exec: realExec,
		profile,
		dir,
		repoRoot: process.cwd(),
		plan,
		integration: integrationWorktree(profile, plan.key),
		epicPr: readEpic(dir).epicPr,
	});
	if (profile.tracker.kind === "github")
		try {
			const lines = await closesLines(ctx.tracker, [
				plan.key,
				...plan.children.map((c) => c.key).filter((k) => landed.has(k)),
			]);
			if (lines) writeFileAtomic(join(dir, CLOSES), `${lines}\n`);
		} catch (e) {
			io.err(
				`could not name the issues the epic PR closes: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	await publishLedger(realExec, dir, () => {
		const after = readRows(dir).rows;
		return renderLedger(
			plan,
			ledgerChildren(
				plan,
				after,
				dir,
				childLanes(plan, files, profile, after),
				scheduleOf(profile),
			),
			runMetrics(plan.children, after),
		);
	});
	io.out(JSON.stringify(report));
	return report.ok ? EXIT.OK : EXIT.PROBLEM;
};
