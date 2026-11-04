import { join } from "node:path";
import { recordParkAnswer } from "../../core/park-answer";

/**
 * The view's other write, besides archiving: one answer to a parked child, appended to its
 * run log, and only while the question shown is the one still waiting.
 */
export function answerPark(
	runsDir: string,
	run: string,
	child: string,
	since: string,
	text: string,
): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(run))
		throw new Error(`not a run key: ${run}`);
	recordParkAnswer(join(runsDir, run), child, text, {
		onlyWaitingSince: since,
	});
}
