import { readFileSync } from "node:fs";
import { amendLand, amendStart, amendWait } from "../../amend/amend";
import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { readRows } from "../../core/runlog";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

const USAGE =
	"usage: portia amend start|wait|land <KEY> --parent <PARENT> [--note-file <file>] [--poll <seconds>]";

/**
 * The spec-amendment path, for a child drive stopped on at `spec-amendment`: `start` runs an
 * amendment worker on that spec alone, `wait` records what it changed, and `land` puts the
 * signed-off amendment on the integration branch. Drive then redispatches the child onto it.
 */
export const amendCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent || !["start", "wait", "land"].includes(sub ?? ""))
		throw new PortiaProblem(USAGE);
	const { profile } = await cliContext();
	if (profile.workers.mode !== "detached")
		throw new PortiaProblem(
			`portia amend starts a detached worker and needs workers.mode "detached" in the profile; it is "${profile.workers.mode}"`,
		);
	const { plan, dir } = await loadForCli(parent);
	const ctx = {
		exec: realExec,
		profile,
		repoRoot: process.cwd(),
		dir,
		plan,
		rows: readRows(dir).rows,
	};
	if (sub === "start") {
		const noteFile = flag(args, "--note-file");
		const note = noteFile ? readFileSync(noteFile, "utf8").trim() : "";
		const rec = await amendStart(ctx, key, note);
		io.out(
			JSON.stringify(rec ? { child: key, pid: rec.pid, log: rec.log } : {}),
		);
		return EXIT.OK;
	}
	if (sub === "wait") {
		const poll = Number(flag(args, "--poll") ?? 5);
		if (!Number.isFinite(poll) || poll <= 0)
			throw new PortiaProblem(
				`--poll <seconds> must be a positive number\n${USAGE}`,
			);
		const w = await amendWait(
			ctx,
			key,
			{
				stallMin: profile.workers.stallMin,
				limitCooldownMin: profile.workers.limitCooldownMin,
			},
			poll * 1000,
		);
		io.out(JSON.stringify(w));
		return w.status === "done" ? EXIT.OK : EXIT.PROBLEM;
	}
	io.out(JSON.stringify(await amendLand(ctx, key)));
	return EXIT.OK;
};
