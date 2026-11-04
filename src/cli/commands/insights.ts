import { EXIT, PortiaProblem } from "../../core/exit";
import { listRuns } from "../../core/runs";
import { insights, renderInsights } from "../../insights/report";
import { cliContext } from "../context";
import type { Command } from "../main";

const USAGE =
	"usage: portia insights [KEY...] [--since <date>] [--json] [--detailed]";

/** Rework and failure across runs; a run counts when its first row is at or after --since. */
export const insightsCommand: Command = async (args, io) => {
	const keys: string[] = [];
	let since: number | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a === "--since") {
			since = Date.parse(args[++i] ?? "");
			if (Number.isNaN(since)) throw new PortiaProblem(USAGE);
		} else if (a === "--json" || a === "--detailed") continue;
		else if (a.startsWith("--")) throw new PortiaProblem(USAGE);
		else keys.push(a);
	}
	const runs = listRuns(keys).filter(
		(r) =>
			since === undefined ||
			(r.rows[0] !== undefined && Date.parse(r.rows[0].at) >= since),
	);
	for (const r of runs) for (const w of r.warnings) io.err(w);
	// A run log can be read anywhere; without a profile the default test globs classify a ripple.
	const globs = await cliContext()
		.then((c) => c.profile.ripple)
		.catch(() => undefined);
	const report = insights(runs, args.includes("--detailed"), globs);
	io.out(
		args.includes("--json") ? JSON.stringify(report) : renderInsights(report),
	);
	return EXIT.OK;
};
