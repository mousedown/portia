import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { accountsOf, allLimited } from "../../core/accounts";
import { modelFor } from "../../core/config";
import { EXIT, PortiaProblem } from "../../core/exit";
import { appendRow, nextAttempt, readRows } from "../../core/runlog";
import { spendCheck } from "../../core/spend";
import {
	closedOutsideRun,
	deriveStates,
	readySet,
	scheduleOf,
} from "../../core/state";
import type { RunRow } from "../../core/types";
import { stateFile } from "../../env/env";
import { envReserved, owner, probes, workerSlots } from "../../env/slots";
import { withLock } from "../../gate/lock";
import { childLanes } from "../../plan/check";
import { questionsWaiting } from "../../questions/questions";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";
import { reconcileWorkers } from "./worker";

export const dispatchCommand: Command = async (args, io) => {
	const key = args[0]?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent)
		throw new PortiaProblem(
			"usage: portia dispatch <KEY> --parent <PARENT> [--check]",
		);
	const check = args.includes("--check");
	const { profile, tracker } = await cliContext();
	const { plan, dir, files } = await loadForCli(parent);
	const c = plan.children.find((x) => x.key === key);
	if (!c) throw new PortiaProblem(`${key} is not a child of ${parent}`);
	const rows = readRows(dir).rows;
	if (closedOutsideRun(plan, rows).includes(key))
		throw new PortiaProblem(
			`${key} is closed outside the run; it is never dispatched`,
		);
	const unanswered = questionsWaiting(profile.askOnce, dir, parent);
	if (unanswered) throw new PortiaProblem(unanswered);
	const over = spendCheck(rows, plan, c, profile);
	if (over) throw new PortiaProblem(over);
	// A detached worker needs an account that is not at its usage limit.
	const limited =
		profile.workers.mode === "detached"
			? allLimited(accountsOf(profile.workers))
			: undefined;
	if (limited) throw new PortiaProblem(limited);
	const model = modelFor(profile, c);
	const detached =
		profile.workers.mode === "detached" ? { worker: "detached" } : {};
	// Recorded so the worker's gates and the re-gate at land agree on it.
	const lane = childLanes(plan, files, profile, rows)?.get(key);
	const waveGated = scheduleOf(profile);
	// Never a child still behind its needs or an earlier wave, nor one landed. A running
	// child may be dispatched again: a resume, or a newer attempt for its worker.
	const guard = (now: RunRow[]) => {
		const state = deriveStates(plan, now, waveGated).get(key);
		if (state === "pending")
			throw new PortiaProblem(
				`${key} is not ready: its needs or an earlier wave have not landed, or an earlier wave gate has not passed`,
			);
		if (state === "landed")
			throw new PortiaProblem(
				`${key} has landed; it is never dispatched again`,
			);
	};
	// Called with the rows read under a lock, so two dispatches never take the same attempt.
	const record = (now: RunRow[], data?: Record<string, unknown>) => {
		const attempt = nextAttempt(now, key);
		appendRow(dir, {
			child: key,
			attempt,
			stage: "dispatched",
			model: { requested: model },
			...(data || lane ? { data: { ...data, ...(lane ? { lane } : {}) } } : {}),
		});
		return attempt;
	};
	const transition = async () => {
		try {
			await tracker.transition(key, profile.transitions.running);
		} catch (e) {
			if (
				!(
					e instanceof PortiaProblem &&
					e.message.includes("no transition named")
				)
			)
				throw e;
		}
	};
	if (profile.perWorkerMb === undefined) {
		if (check) {
			guard(rows);
			io.out(JSON.stringify({ child: key, lane }));
			return EXIT.OK;
		}
		const attempt = await withLock(
			dir,
			async () => {
				const now = readRows(dir).rows;
				guard(now);
				return record(now);
			},
			{ name: "dispatch.lock", pollMs: 100 },
		);
		await transition();
		io.out(JSON.stringify({ child: key, attempt, model, ...detached, lane }));
		return EXIT.OK;
	}

	// A stalled detached worker is stopped and failed first, so it frees its slot.
	if (profile.workers.mode === "detached")
		await reconcileWorkers(plan, dir, { applyFinished: false });
	const probe = probes();
	// One decision at a time across every run on the machine, so two runs never take the same slot.
	const decided = await withLock(
		dirname(dir),
		async () => {
			const now = readRows(dir).rows;
			guard(now);
			// Admitted only by an env up just now: an environment that stayed up from an earlier attempt is checked again.
			const admitted =
				existsSync(stateFile(dir, key)) &&
				envReserved(now, probe.now()).has(key);
			const slots = workerSlots(profile, plan.key, now, probe, {
				skip: [key, ...closedOutsideRun(plan, now)],
				admitted,
				dir,
			});
			if (!slots) throw new Error("unreachable: perWorkerMb is set");
			const others = readySet(deriveStates(plan, now, waveGated)).filter(
				(k) => k !== key,
			);
			if (slots.available === 0) return { slots, others };
			return {
				slots,
				others,
				attempt: check ? undefined : record(now, owner(probe)),
			};
		},
		{ name: "slots.lock", pollMs: 200 },
	);
	const { slots, others } = decided;
	if (slots.available === 0) {
		if (slots.used === 0)
			throw new PortiaProblem(
				`no memory for a worker: one needs ${profile.perWorkerMb} MB free above minFreeMb (${profile.minFreeMb} MB), and this run has none running to wait on`,
			);
		// No slot free: record nothing, so the same call starts it after a landing.
		io.out(
			JSON.stringify({ child: key, lane, waiting: [key, ...others], slots }),
		);
		return EXIT.NOTHING;
	}
	const waiting = others.slice(slots.available - 1);
	if (check) {
		io.out(JSON.stringify({ child: key, lane, slots, waiting }));
		return EXIT.OK;
	}
	await transition();
	io.out(
		JSON.stringify({
			child: key,
			attempt: decided.attempt,
			model,
			...detached,
			lane,
			slots,
			waiting,
		}),
	);
	return EXIT.OK;
};
