import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { runMetrics } from "../../core/metrics";
import { readRows } from "../../core/runlog";
import { scheduleOf } from "../../core/state";
import { publishLedger } from "../../ledger/publish";
import { ledgerChildren, renderLedger } from "../../ledger/render";
import { childLanes } from "../../plan/check";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";

/** Renders the ledger; publishes it into the epic PR body unless --print. */
export const ledgerCommand: Command = async (args, io) => {
	const key = args.find((a) => !a.startsWith("--"));
	if (!key) throw new PortiaProblem("usage: portia ledger <KEY> [--print]");
	const { profile } = await cliContext();
	const { plan, dir, files } = await loadForCli(key);
	// Rendered from the run log as it stands when called, so a publish waiting on another
	// renders after it.
	const markdown = () => {
		const rows = readRows(dir).rows;
		return renderLedger(
			plan,
			ledgerChildren(
				plan,
				rows,
				dir,
				childLanes(plan, files, profile, rows),
				scheduleOf(profile),
			),
			runMetrics(plan.children, rows),
		);
	};
	if (args.includes("--print")) {
		io.out(markdown());
		return EXIT.OK;
	}
	await publishLedger(realExec, dir, markdown);
	return EXIT.OK;
};
