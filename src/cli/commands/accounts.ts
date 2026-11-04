import {
	accountStatus,
	accountsOf,
	benchText,
	clearLimits,
	isBenched,
} from "../../core/accounts";
import { EXIT, PortiaProblem } from "../../core/exit";
import { cliContext } from "../context";
import type { Command } from "../main";

const USAGE =
	"usage: portia accounts [--json] | portia accounts clear [<name>...]";

/** The accounts detached workers rotate over, and lifting a usage limit that reset early or a login that is back. */
export const accountsCommand: Command = async (args, io) => {
	const { profile } = await cliContext();
	const accounts = accountsOf(profile.workers);
	if (args[0] === "clear") {
		const names = args.slice(1);
		const unknown = names.filter((n) => !accounts.some((a) => a.name === n));
		if (unknown.length)
			throw new PortiaProblem(
				`no account named ${unknown.join(", ")}; the profile has ${accounts.map((a) => a.name).join(", ")}`,
			);
		const lifted = clearLimits(names);
		io.out(
			lifted.length
				? `lifted the limit on ${lifted.join(", ")}`
				: "no account was at its usage limit or logged out",
		);
		return EXIT.OK;
	}
	if (args.some((a) => a !== "--json")) throw new PortiaProblem(USAGE);
	const status = accountStatus(accounts);
	if (args.includes("--json")) io.out(JSON.stringify(status));
	else
		for (const a of status)
			io.out(
				`${a.name}\t${a.configDir ?? (a.defaultLogin ? "(the default login)" : "(the CLI's own login)")}\t${benchText(a)}`,
			);
	// Exit 10 when no account can take a worker now, as dispatch would refuse.
	return status.every(isBenched) ? EXIT.NOTHING : EXIT.OK;
};
