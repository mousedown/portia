import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resultsDir } from "./run";
import type { RunResult } from "./types";

/**
 * `eval void`: marks a saved result as broken by the harness rather than the arm, with why
 * and when. The result, its artifacts and its ledger tokens stay; reports, comparisons and
 * the cache skip it from then on. Voiding again replaces the reason.
 */
export function voidRun(o: {
	root: string;
	suite: string;
	arm: string;
	epic: string;
	n: number;
	reason: string;
	now?: Date;
}): RunResult {
	const file = join(resultsDir(o.root, o.suite, o.arm, o.epic), `${o.n}.json`);
	if (!existsSync(file))
		throw new Error(
			`no result for run ${o.n} of ${o.arm} on ${o.epic}: expected ${file}`,
		);
	if (!o.reason.trim()) throw new Error("say why the run is void: --reason");
	const result: RunResult = JSON.parse(readFileSync(file, "utf8"));
	const voided = {
		...result,
		void: {
			reason: o.reason.trim(),
			at: (o.now ?? new Date()).toISOString(),
		},
	};
	writeFileSync(file, `${JSON.stringify(voided, null, "\t")}\n`);
	return voided;
}
