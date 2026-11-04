import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { readRows } from "../../core/runlog";
import { deriveStates, scheduleOf } from "../../core/state";
import type { ChildState } from "../../core/types";
import { notifySpec, remindQuietly } from "../../notify/park";
import { childLanes } from "../../plan/check";
import { renderStatus, toView } from "../../render/status";
import { detect } from "../../render/style";
import { resume } from "../../resume/resume";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { reconcileWorkers } from "./worker";

/** Exit 11 on a problem, 10 when nothing is actionable and nothing is ready, else 0. */
export function resumeExit(
	result: { actions: unknown[]; problems: unknown[] },
	states: Map<string, ChildState>,
): number {
	if (result.problems.length) return EXIT.PROBLEM;
	const readyWaiting = [...states.values()].includes("ready");
	return result.actions.length === 0 && !readyWaiting ? EXIT.NOTHING : EXIT.OK;
}

export const resumeCommand: Command = async (args, io) => {
	const key = args.find((a) => !a.startsWith("--"));
	if (!key) throw new PortiaProblem("usage: portia resume <PARENT>");
	const { profile, tracker } = await cliContext();
	const { plan, dir, files } = await loadForCli(key);
	const workers =
		profile.workers.mode === "detached"
			? await reconcileWorkers(plan, dir, { applyFinished: true })
			: {};
	const { actions, problems } = await resume(plan, {
		exec: realExec,
		profile,
		repoRoot: process.cwd(),
		dir,
		tracker,
		landedTransition: profile.transitions.landed,
		alive: Object.fromEntries(
			Object.entries(workers)
				.filter(([, w]) => w.state === "alive")
				.map(([k, w]) => [k, w.detail]),
		),
	});
	await remindQuietly(dir, plan.key, {
		exec: realExec,
		notify: notifySpec(profile),
	});
	const rows = readRows(dir).rows;
	const states = deriveStates(plan, rows, scheduleOf(profile));
	io.out(JSON.stringify({ actions, problems }));
	io.out(
		renderStatus(
			toView(plan, states, {
				lanes: childLanes(plan, files, profile, rows),
			}),
			detect(),
		),
	);
	return resumeExit({ actions, problems }, states);
};
