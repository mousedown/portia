import { approveTouches, readApprovals } from "../../core/approvals";
import { EXIT, PortiaProblem } from "../../core/exit";
import { loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

const USAGE =
	'usage: portia touches allow <KEY> --parent <PARENT> <glob...> [--why "<text>"] | portia touches list <KEY> --parent <PARENT>';
const VALUED = new Set(["--parent", "--why"]);

/** The positional arguments after `<sub> <KEY>`, leaving out flags and their values. */
const positionals = (args: string[]): string[] =>
	args
		.slice(2)
		.filter(
			(a, i, all) => !a.startsWith("--") && !VALUED.has(all[i - 1] ?? ""),
		);

export const touchesCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const parent = flag(args, "--parent")?.toUpperCase();
	if (!key || !parent || (sub !== "allow" && sub !== "list"))
		throw new PortiaProblem(USAGE);
	const { plan, dir } = await loadForCli(parent);
	if (!plan.children.some((c) => c.key === key))
		throw new PortiaProblem(`${key} is not a child of ${parent}`);
	if (sub === "allow") {
		const globs = positionals(args);
		if (!globs.length) throw new PortiaProblem(USAGE);
		approveTouches(dir, key, globs, flag(args, "--why"));
	}
	const approvals = readApprovals(dir, key);
	io.out(
		approvals.length
			? approvals
					.map((a) => `${a.glob}${a.why ? `  # ${a.why}` : ""}`)
					.join("\n")
			: `no extra files approved for ${key}`,
	);
	return EXIT.OK;
};
