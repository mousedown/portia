import { readFileSync } from "node:fs";
import { accountsOf, pickAccount } from "../../core/accounts";
import { isDryRun, realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { readRows } from "../../core/runlog";
import { deriveStates } from "../../core/state";
import type { ParentPlan } from "../../core/types";
import { readEnv } from "../../env/env";
import { notifySpec, remindQuietly } from "../../notify/park";
import {
	collect,
	currentProcs,
	probe,
	readRecord,
	readWorker,
	running,
	startWorker,
	workerPaths,
} from "../../worker/detached";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { renderBrief } from "./brief";
import { flag } from "./env";
import { applyResult, resultExit } from "./result";

const USAGE =
	"usage: portia worker start <KEY> --parent <PARENT> [--note-file <file>] | portia worker wait <KEY> --parent <PARENT> [--poll <seconds>]";

export const workerCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent || (sub !== "start" && sub !== "wait"))
		throw new PortiaProblem(USAGE);
	const { profile } = await cliContext();
	if (profile.workers.mode !== "detached")
		throw new PortiaProblem(
			`portia worker needs workers.mode "detached" in the profile; it is "${profile.workers.mode}"`,
		);
	const loaded = await loadForCli(parent);
	const { dir } = loaded;
	const rows = readRows(dir).rows;
	const dispatched = rows
		.filter((r) => r.child === key && r.stage === "dispatched")
		.at(-1);
	if (!dispatched)
		throw new PortiaProblem(
			`${key} was never dispatched; run portia dispatch first`,
		);
	const ctx = {
		exec: realExec,
		stallMin: profile.workers.stallMin,
		limitCooldownMin: profile.workers.limitCooldownMin,
		accounts: accountsOf(profile.workers),
	};

	if (sub === "start") {
		if (
			rows.some(
				(r) =>
					r.child === key &&
					r.stage === "result" &&
					r.attempt === dispatched.attempt,
			)
		)
			throw new PortiaProblem(
				`${key} attempt ${dispatched.attempt} already has a result; run portia dispatch first`,
			);
		const last = readRecord(dir, key);
		const current = last?.attempt === dispatched.attempt;
		if (last && current && running(last))
			throw new PortiaProblem(
				`${key} attempt ${dispatched.attempt} already runs as pid ${last.pid}`,
			);
		if (last && current && (await probe(last, ctx)).state === "finished")
			throw new PortiaProblem(
				`${key} attempt ${dispatched.attempt} has finished; run portia worker wait to apply its result`,
			);
		const env = readEnv(dir, key);
		const noteFile = flag(args, "--note-file");
		const note = noteFile ? readFileSync(noteFile, "utf8").trim() : "";
		const brief =
			(await renderBrief(
				key,
				parent,
				workerPaths(dir, key, dispatched.attempt).result,
				loaded,
			)) + (note ? `\n## Answer from the person\n\n${note}\n` : "");
		const model = dispatched.model?.requested ?? profile.models.standard;
		if (isDryRun()) {
			io.err(
				`[dry-run] would start ${profile.workers.command} for ${key} in ${env.worktree}`,
			);
			return EXIT.OK;
		}
		// An older attempt's worker must be gone before another shares its worktree.
		if (last && !current && running(last)) {
			await currentProcs().stop(last.pid);
			if (running(last))
				throw new PortiaProblem(
					`${key} attempt ${last.attempt} still runs as pid ${last.pid}; stop it before starting attempt ${dispatched.attempt}`,
				);
		}
		// The next account in rotation not at its usage limit; refuses when every one is.
		const account = pickAccount(accountsOf(profile.workers));
		const rec = startWorker({
			dir,
			key,
			attempt: dispatched.attempt,
			role:
				loaded.plan.children.find((c) => c.key === key)?.wave === 0
					? "spine"
					: "child",
			model,
			worktree: env.worktree,
			brief,
			workers: profile.workers,
			denyRules: profile.denyRules,
			account,
		});
		io.out(
			JSON.stringify({
				child: key,
				attempt: rec.attempt,
				pid: rec.pid,
				log: rec.log,
				account: account.name,
			}),
		);
		return EXIT.OK;
	}

	const rec = readWorker(dir, key, rows);
	if (!rec)
		throw new PortiaProblem(
			`${key} has no detached worker for attempt ${dispatched.attempt}; run portia worker start`,
		);
	const poll = Number(flag(args, "--poll") ?? 5);
	if (!Number.isFinite(poll) || poll <= 0)
		throw new PortiaProblem(
			`--poll <seconds> must be a positive number\n${USAGE}`,
		);
	// Siblings parked while this worker runs are reminded from here, at most once a minute.
	let reminded = 0;
	for (;;) {
		if (Date.now() - reminded >= 60_000) {
			reminded = Date.now();
			await remindQuietly(dir, parent, {
				exec: realExec,
				notify: notifySpec(profile),
			});
		}
		const done = await collect(rec, ctx);
		if (done) {
			const applied = await applyResult(
				key,
				parent,
				done.outcome,
				done.tokens,
				rec.attempt,
			);
			io.out(JSON.stringify(applied));
			return resultExit(applied);
		}
		await new Promise((r) => setTimeout(r, poll * 1000));
	}
};

export type WorkerState = "alive" | "finished" | "stalled";

/**
 * Probes every running child's detached worker. A stalled one is stopped and recorded
 * as failed; with `applyFinished`, a finished one's result is applied too, as resume does.
 */
export async function reconcileWorkers(
	plan: ParentPlan,
	dir: string,
	opts: { applyFinished: boolean },
): Promise<Record<string, { state: WorkerState; detail: string }>> {
	const { profile } = await cliContext();
	const ctx = {
		exec: realExec,
		stallMin: profile.workers.stallMin,
		limitCooldownMin: profile.workers.limitCooldownMin,
		accounts: accountsOf(profile.workers),
		procs: currentProcs(),
	};
	const rows = readRows(dir).rows;
	const out: Record<string, { state: WorkerState; detail: string }> = {};
	const recs = [...deriveStates(plan, rows)].flatMap(([key, state]) => {
		const rec = state === "running" ? readWorker(dir, key, rows) : undefined;
		return rec ? [{ key, rec }] : [];
	});
	// Workers are probed together; results are applied one at a time, in plan order.
	const probes = await Promise.all(recs.map(({ rec }) => probe(rec, ctx)));
	let applied = false;
	for (const [i, { key, rec }] of recs.entries()) {
		let seen = probes[i];
		if (!seen) continue;
		// Applying an earlier result takes time (stopping its worker, a tracker comment,
		// perhaps a touches decision), so a stall seen before it is checked again.
		if (seen.state === "stalled" && applied) seen = await probe(rec, ctx);
		if (seen.state === "alive") {
			out[key] = { state: "alive", detail: `pid ${rec.pid} is working` };
			continue;
		}
		if (seen.state === "finished" && !opts.applyFinished) {
			out[key] = { state: "finished", detail: "its result is waiting" };
			continue;
		}
		const done = await collect(rec, ctx, seen);
		if (!done) continue;
		applied = true;
		// The caller loaded the plan just now; `worker wait` reloads instead, as its own
		// load may be hours old by the time the worker finishes.
		const result = await applyResult(
			key,
			plan.key,
			done.outcome,
			done.tokens,
			rec.attempt,
			{ plan, dir },
		);
		out[key] = {
			state: seen.state,
			detail:
				seen.state === "stalled"
					? `${seen.reason}; stopped and recorded as failed`
					: `result applied: ${result.status}`,
		};
	}
	return out;
}
