import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { openClaim } from "../../amend/amend";
import { must, realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { runDir } from "../../core/rundir";
import { readRows } from "../../core/runlog";
import {
	recordSignoff,
	type SignedBy,
	type Signoff,
	spineResult,
} from "../../core/signoff";
import type { RunRow } from "../../core/types";
import { readEnv } from "../../env/env";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

const USAGE =
	"usage: portia signoff plan <PARENT> --from <plan file> [--by person|eval] [--no] [--note <text>] | portia signoff specs <PARENT> [--child <SPINE> | --amend <KEY>] [--by person|eval|reviewer] [--no] [--note <text>]";

type Answer = Pick<Signoff, "approved" | "by" | "note">;

/** Records the answer to the drafted plan in `from` as an `approval` row. */
export async function signPlan(
	key: string,
	from: string,
	answer: Answer,
): Promise<RunRow> {
	let text: string;
	try {
		text = readFileSync(from, "utf8");
	} catch (e) {
		throw new PortiaProblem(
			`could not read the plan file ${from}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	return recordSignoff(runDir(key), {
		...answer,
		kind: "plan",
		child: key,
		attempt: 0,
		commit: await must(realExec, "git", ["rev-parse", "HEAD"]),
		// The table is shown once the last draft is written, so its mtime is when they were asked.
		askedAt: statSync(from).mtime.toISOString(),
		plan: createHash("sha256").update(text).digest("hex"),
	});
}

/** Records the answer to the spine's acceptance specs as a `signoff` row on its last done attempt. */
export async function signSpecs(
	key: string,
	child: string | undefined,
	answer: Answer,
): Promise<RunRow> {
	const { plan, dir } = await loadForCli(key);
	const spines = plan.children.filter((c) => c.wave === 0).map((c) => c.key);
	const spine = child?.toUpperCase() ?? spines[0];
	if (!spine || !spines.includes(spine) || (spines.length > 1 && !child))
		throw new PortiaProblem(
			spines.length
				? `name the spine with --child: one of ${spines.join(", ")}`
				: `${key} has no wave 0 child to sign off`,
		);
	const result = spineResult(readRows(dir).rows, spine);
	if (!result)
		throw new PortiaProblem(
			`${spine} has no done result yet: its specs are signed off after its worker finishes`,
		);
	const commit =
		typeof result.data?.head === "string"
			? result.data.head
			: await must(realExec, "git", ["rev-parse", "HEAD"], {
					cwd: readEnv(dir, spine).worktree,
				});
	return recordSignoff(dir, {
		...answer,
		kind: "specs",
		child: spine,
		attempt: result.attempt,
		commit,
		askedAt: result.at,
	});
}

/**
 * Records the answer to a spec amendment, the claim `key` parked on, as a `signoff` row on
 * `key` naming the spec in `amends`, for the amendment's head: `portia amend land` needs it.
 */
export async function signAmendment(
	parent: string,
	key: string,
	answer: Answer,
): Promise<RunRow> {
	const { plan, dir } = await loadForCli(parent);
	const { profile } = await cliContext();
	const rows = readRows(dir).rows;
	const { attempt, claim } = openClaim({ plan, rows, profile }, key);
	const done = rows
		.filter(
			(r) => r.child === key && r.stage === "amend" && r.attempt === attempt,
		)
		.at(-1);
	if (done?.status !== "done")
		throw new PortiaProblem(
			`${key}'s amendment has not finished done; run portia amend wait first`,
		);
	return recordSignoff(dir, {
		...answer,
		kind: "specs",
		child: key,
		attempt,
		commit: String(done.data?.head ?? ""),
		askedAt: done.at,
		amends: claim.path,
	});
}

/**
 * Records the person's answer to a sign-off in the run log: the plan's approval before
 * `portia plan write`, and the spine's acceptance specs before it lands (W5).
 */
export const signoffCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const by = (flag(args, "--by") ?? "person") as SignedBy;
	const from = flag(args, "--from");
	if (
		!key ||
		(sub !== "plan" && sub !== "specs") ||
		(sub === "plan" && !from) ||
		(by !== "person" && by !== "eval" && by !== "reviewer") ||
		// The reviewer only refuses specs; a yes is always the person's.
		(by === "reviewer" && (!args.includes("--no") || sub !== "specs"))
	)
		throw new PortiaProblem(USAGE);
	const answer = {
		approved: !args.includes("--no"),
		by,
		note: flag(args, "--note"),
	};
	const amend = flag(args, "--amend")?.toUpperCase();
	const row =
		sub === "plan"
			? await signPlan(key, from as string, answer)
			: amend
				? await signAmendment(key, amend, answer)
				: await signSpecs(key, flag(args, "--child"), answer);
	io.out(JSON.stringify(row));
	return EXIT.OK;
};
