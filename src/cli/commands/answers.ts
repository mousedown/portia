import { EXIT, PortiaProblem } from "../../core/exit";
import { waitOf } from "../../core/park";
import { answeredSince } from "../../core/park-answer";
import { runPath } from "../../core/rundir";
import { readRows } from "../../core/runlog";
import type { Command } from "../main";
import { flag } from "./env";

const USAGE =
	"usage: portia answers wait <PARENT> [--since <iso>] [--poll <seconds>]";

/** Read-only: waits for an answer given from `portia view`, so the session can drive again. */
export const answersCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	if (sub !== "wait" || !key) throw new PortiaProblem(USAGE);
	const since = flag(args, "--since");
	const poll = Number(flag(args, "--poll") ?? 2);
	if (!Number.isFinite(poll) || poll <= 0)
		throw new PortiaProblem(
			`--poll <seconds> must be a positive number\n${USAGE}`,
		);
	const dir = runPath(key);
	for (;;) {
		const { rows } = readRows(dir);
		const answered = answeredSince(rows, since);
		if (answered.length) {
			io.out(JSON.stringify({ answered }));
			return EXIT.OK;
		}
		const children = new Set(rows.map((r) => r.child));
		const waiting = [...children].some(
			(c) => waitOf(rows.filter((r) => r.child === c))?.kind === "question",
		);
		if (!waiting) {
			io.out(JSON.stringify({ answered: [] }));
			return EXIT.NOTHING;
		}
		await new Promise((r) => setTimeout(r, poll * 1000));
	}
};
