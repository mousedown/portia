import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { readRows } from "../../core/runlog";
import {
	closedOutsideRun,
	closedWarning,
	deriveStates,
	readySet,
	scheduleOf,
	waveGateDue,
} from "../../core/state";
import { probes, workerSlots } from "../../env/slots";
import { notifySpec, remindQuietly } from "../../notify/park";
import { childLanes } from "../../plan/check";
import { questionsWaiting } from "../../questions/questions";
import { renderStatus, toView } from "../../render/status";
import { detect } from "../../render/style";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { reconcileWorkers } from "./worker";

/** Exit 0 with output; with --json, exit 10 when nothing is ready to dispatch and no wave gate is due. */
export const statusCommand: Command = async (args, io) => {
	const key = args.find((a) => !a.startsWith("--"));
	if (!key) throw new PortiaProblem("usage: portia status <KEY> [--json]");
	const { profile } = await cliContext();
	const { plan, dir, files } = await loadForCli(key);
	const workers =
		profile.workers.mode === "detached"
			? await reconcileWorkers(plan, dir, { applyFinished: false })
			: undefined;
	await remindQuietly(dir, plan.key, {
		exec: realExec,
		notify: notifySpec(profile),
	});
	const rows = readRows(dir).rows;
	const lanes = childLanes(plan, files, profile, rows);
	const states = deriveStates(plan, rows, scheduleOf(profile));
	const due = profile.waveGate ? waveGateDue(plan, rows) : undefined;
	const warnings = [
		...closedOutsideRun(plan, rows).map(closedWarning),
		...Object.entries(workers ?? {})
			.filter(([, w]) => w.state === "stalled")
			.map(([k, w]) => `${k}: stalled, ${w.detail}`),
	];
	const slots = workerSlots(profile, plan.key, rows, probes(), {
		skip: closedOutsideRun(plan, rows),
		dir,
	});
	const waiting = questionsWaiting(profile.askOnce, dir, plan.key);
	if (waiting) warnings.push(waiting);
	if (args.includes("--json")) {
		const ready = readySet(states);
		io.out(
			JSON.stringify({
				parent: plan.key,
				states: Object.fromEntries(states),
				waves: Object.fromEntries(plan.children.map((c) => [c.key, c.wave])),
				ready,
				warnings,
				...(workers
					? {
							workers: Object.fromEntries(
								Object.entries(workers).map(([k, w]) => [k, w.state]),
							),
						}
					: {}),
				lanes: lanes && Object.fromEntries(lanes),
				...(slots ? { slots } : {}),
				...(due === undefined ? {} : { waveGate: { wave: due, due: true } }),
			}),
		);
		return ready.length || due !== undefined ? EXIT.OK : EXIT.NOTHING;
	}
	io.out(renderStatus(toView(plan, states, { lanes, slots }), detect()));
	if (due !== undefined)
		io.out(`due   the wave ${due} gate: portia gate wave ${plan.key}`);
	for (const w of warnings) io.out(`warn  ${w}`);
	return EXIT.OK;
};
