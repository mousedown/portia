import { realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { parkNeedsPerson } from "../../core/park";
import { failures, nextAttempt, readRows } from "../../core/runlog";
import { decide } from "../../decide/decide";
import { jevFromProfile } from "../../decide/jev";
import { notifyPark, notifySpec } from "../../notify/park";
import { isAccountFailure } from "../../worker/usage-limit";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

export const decideCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	const reason = flag(args, "--reason");
	const question = flag(args, "--question");
	if (
		!key ||
		!parent ||
		(sub !== "failure" && sub !== "park") ||
		(sub === "failure" ? !reason : !question)
	)
		throw new PortiaProblem(
			'usage: portia decide failure <KEY> --parent <PARENT> --reason "<text>" | portia decide park <KEY> --parent <PARENT> --question "<text>"',
		);
	const { plan, dir } = await loadForCli(parent);
	const c = plan.children.find((x) => x.key === key);
	if (!c) throw new PortiaProblem(`${key} is not a child of ${parent}`);
	const { profile, tracker } = await cliContext();
	const ctx = { profile, dir, jev: jevFromProfile(profile) };
	const base = { child: key, touches: c.touches };
	const decision =
		sub === "failure"
			? await decide(
					"failure",
					{
						...base,
						failure: {
							reason: reason ?? "",
							// A usage limit or a missing login is the account's, not the child's: it spends no retry.
							attempts: failures(readRows(dir).rows, key).filter(
								(f) => !isAccountFailure(f.reason),
							).length,
						},
					},
					ctx,
				)
			: await decide(
					"park-answerable",
					{
						...base,
						park: {
							question: question ?? "",
							ticket: (await tracker.issue(key)).description,
						},
					},
					ctx,
				);
	// A failure decided as park goes to the person, unless a usage limit frees it on its own.
	if (
		sub === "failure" &&
		decision.answer === "park" &&
		parkNeedsPerson(decision.why)
	)
		await notifyPark(
			{
				parent,
				child: key,
				question: [reason, decision.why].filter(Boolean).join("\n\n"),
				attempt: Math.max(0, nextAttempt(readRows(dir).rows, key) - 1),
			},
			{ exec: realExec, notify: notifySpec(profile) },
		);
	io.out(JSON.stringify(decision));
	return EXIT.OK;
};
