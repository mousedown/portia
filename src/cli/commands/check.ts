import { EXIT, PortiaProblem } from "../../core/exit";
import { runPath } from "../../core/rundir";
import { readRows } from "../../core/runlog";
import { closedOutsideRun, closedWarning, startedIn } from "../../core/state";
import { check } from "../../plan/check";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";

export const checkCommand: Command = async (args, io) => {
	const key = args[0];
	if (!key) throw new PortiaProblem("usage: portia check <KEY>");
	const { plan, files, findings, issues } = await loadForCli(key, {
		allowFindings: true,
	});
	// Read the run log without creating the run directory: check never makes one.
	const rows = readRows(runPath(plan.key)).rows;
	const shut = closedOutsideRun(plan, rows);
	const closed = shut.map((k) => ({
		rule: "closed" as const,
		level: "warn" as const,
		child: k,
		message: closedWarning(k),
	}));
	const { profile, tracker } = await cliContext();
	const parent = await tracker.issue(plan.key, { blockers: false });
	const tickets = new Map(
		[parent, ...issues].map((i) => [i.key, `${i.summary}\n${i.description}`]),
	);
	const all = [
		...findings,
		...closed,
		...check(plan, files, shut, profile.maxSize, profile, tickets, [
			...startedIn(rows),
		]),
	];
	for (const f of all)
		io.out(`${f.level.padEnd(5)}  ${f.rule.padEnd(12)} ${f.message}`);
	const errors = all.filter((f) => f.level === "error").length;
	io.out(
		errors
			? `${errors} error(s): dispatch blocked`
			: "ok: the plan passes portia check",
	);
	return errors ? EXIT.PROBLEM : EXIT.OK;
};
