import { integrationBranch } from "../../core/branches";
import { EXIT } from "../../core/exit";
import { listRuns } from "../../core/runs";
import { gitHistory } from "../../verify/git";
import { countReceipts, renderReceipts, verifyRun } from "../../verify/verify";
import { cliContext } from "../context";
import type { Command } from "../main";

/** Exit 0 when every landed child has its receipts, 11 on any exception. */
export const verifyCommand: Command = async (args, io) => {
	const { profile, repoRoot } = await cliContext();
	const keys = args.filter((a) => !a.startsWith("--"));
	const runs = [];
	for (const run of listRuns(keys)) {
		for (const w of run.warnings) io.err(`warn  ${w}`);
		const history = await gitHistory(
			integrationBranch(profile, run.key),
			repoRoot,
		);
		runs.push(await verifyRun(run, history));
	}
	const counts = countReceipts(runs);
	const failed = Object.keys(counts.exceptions).length > 0;
	io.out(
		args.includes("--json") ? JSON.stringify(counts) : renderReceipts(runs),
	);
	return failed ? EXIT.PROBLEM : EXIT.OK;
};
