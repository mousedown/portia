import { readFileSync } from "node:fs";
import { PortiaProblem } from "../../core/exit";
import { answerable } from "../../core/park";
import { appendRow, readRows } from "../../core/runlog";
import { drive } from "../../drive/run";
import {
	type DriveResult,
	renderDrive,
	type Stop,
	stopExit,
	stopLine,
} from "../../drive/types";
import { cliContext, loadForCli } from "../context";
import type { Command, Io } from "../main";
import { flag } from "./env";

const USAGE =
	"usage: portia drive <PARENT> [--json] [--answer <KEY> --note-file <file>]";

/** The setting drive needs: it starts and waits on workers itself, so none can be a subagent. */
export const DETACHED_SETTING = 'workers.mode: "detached"';

function print(io: Io, r: DriveResult, json: boolean): number {
	io.out(json ? JSON.stringify(r) : renderDrive(r));
	return stopExit(r.stop);
}

/** Records the person's answer to a child drive stopped on for one, so the next drive redispatches it with the answer. */
async function recordAnswer(
	parent: string,
	key: string,
	noteFile: string,
): Promise<void> {
	const { plan, dir } = await loadForCli(parent);
	if (!plan.children.some((c) => c.key === key))
		throw new PortiaProblem(`${key} is not a child of ${parent}`);
	const wait = answerable(readRows(dir).rows.filter((r) => r.child === key));
	if (!wait)
		throw new PortiaProblem(
			`${key} is not parked on a question, nor a park or failure put to a person`,
		);
	let answer: string;
	try {
		answer = readFileSync(noteFile, "utf8").trim();
	} catch (e) {
		throw new PortiaProblem(
			`could not read the answer file ${noteFile}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!answer) throw new PortiaProblem(`the answer file ${noteFile} is empty`);
	appendRow(dir, {
		child: key,
		attempt: wait.attempt,
		stage: "decision",
		status: "answer",
		data: { kind: "parked", by: "person", answer, why: wait.text },
	});
}

/**
 * `portia drive <PARENT>`: dispatches, starts and waits on detached workers, applies
 * results, lands and gates until the run needs a person or the AI, then names the stop.
 * Exit 0 at epic-ready, 10 at a stop for a person or the AI, 11 when it failed or broke.
 */
export const driveCommand: Command = async (args, io) => {
	const parent = args[0]?.startsWith("--") ? undefined : args[0]?.toUpperCase();
	const answer = flag(args, "--answer")?.toUpperCase();
	const noteFile = flag(args, "--note-file");
	if (!parent || Boolean(answer) !== Boolean(noteFile))
		throw new PortiaProblem(USAGE);
	const json = args.includes("--json");
	const { profile } = await cliContext();
	if (profile.workers.mode !== "detached") {
		const stop: Stop = {
			kind: "error",
			message: `portia drive starts every worker itself and needs ${DETACHED_SETTING} in the profile; it is "${profile.workers.mode}"`,
		};
		if (json) return print(io, { parent, steps: [], stop }, json);
		io.err(stopLine(stop));
		return stopExit(stop);
	}
	if (answer && noteFile) await recordAnswer(parent, answer, noteFile);
	return print(io, await drive(parent), json);
};
