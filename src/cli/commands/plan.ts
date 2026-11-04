import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../core/atomic";
import { isDryRun, must, realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { isPlanUrl, PLAN_LINK_FILE, planUrlOf } from "../../core/plan-link";
import { runDir, runPath } from "../../core/rundir";
import { readRows } from "../../core/runlog";
import { rippleWarnings } from "../../plan/check";
import {
	type Coupling,
	couplingWarnings,
	specCoupling,
} from "../../plan/coupling";
import { planContext, validatePlan, writePlan } from "../../plan/draft";
import { planPage } from "../../plan/page";
import { repoFiles, topLevelOf } from "../../plan/repo";
import { planRipples } from "../../plan/ripple";
import { cliContext, loadForCli } from "../context";
import type { Command } from "../main";
import { flag } from "./env";

const USAGE =
	"usage: portia plan context <PARENT> --out <file> | portia plan write <PARENT> --from <file> [--json] | portia plan specs <PARENT> [--dir <checkout>] [--json] | portia plan page <PARENT> --out <file> [--json] | portia plan link <PARENT> <url>";

/** The link `plan link` recorded for this run, if any. Read-only. */
function recordedLink(key: string): string | undefined {
	try {
		return planUrlOf(
			JSON.parse(readFileSync(join(runPath(key), PLAN_LINK_FILE), "utf8")),
		);
	} catch {
		return undefined;
	}
}

/** Writes the plan's page for the Artifact tool to publish, and names the link it already has. */
async function pageCommand(
	key: string,
	out: string,
	json: boolean,
	io: Parameters<Command>[1],
): Promise<number> {
	// A run under way may hold findings; the page shows the plan whatever they say.
	const { plan } = await loadForCli(key, { allowFindings: true });
	writeFileSync(out, planPage(plan, new Date().toISOString()));
	const url = recordedLink(key);
	io.out(
		json
			? JSON.stringify({ out, url: url ?? null })
			: `${key}: plan page -> ${out}${url ? ` (published at ${url})` : ""}`,
	);
	return EXIT.OK;
}

/** Records where the plan's page was published, for `portia view` to link. */
function linkCommand(
	key: string,
	url: string,
	io: Parameters<Command>[1],
): number {
	if (!isPlanUrl(url))
		throw new PortiaProblem(
			`not a Claude artifact link: ${url} (expected https://claude.ai/artifact/<id> or https://claude.ai/code/artifact/<id>)`,
		);
	if (isDryRun()) {
		io.out(`${key}: would record the plan page ${url}`);
		return EXIT.OK;
	}
	writeFileAtomic(
		join(runDir(key), PLAN_LINK_FILE),
		`${JSON.stringify({ url, at: new Date().toISOString() })}\n`,
	);
	io.out(`${key}: plan page ${url}`);
	return EXIT.OK;
}

/**
 * Read-only: the acceptance specs a spine wrote, checked for a scenario whose spec reaches
 * another child's work that its owner does not need. Each spec is read from its spine's
 * worktree, or from `--dir`. Couplings are warnings, so it exits 0 either way.
 */
async function specsCommand(
	key: string,
	dir: string | undefined,
	json: boolean,
	io: Parameters<Command>[1],
): Promise<number> {
	const { plan, issues } = await loadForCli(key);
	const { profile } = await cliContext();
	const spines = plan.children.filter(
		(c) => c.wave === 0 && Object.keys(c.acceptance).length,
	);
	const roots = dir
		? [dir]
		: spines.map((c) => join(profile.worktreesDir, profile.repo, c.key));
	const tickets = new Map(
		issues.map((i) => [i.key, `${i.summary}\n${i.description}`]),
	);
	const seen = new Set<string>();
	const coupling: Coupling[] = [];
	for (const root of roots) {
		if (!existsSync(root))
			throw new PortiaProblem(
				`no checkout at ${root}: the spine has not written its specs there yet (or pass --dir)`,
			);
		const files = (
			await must(
				realExec,
				"git",
				["ls-files", "--cached", "--others", "--exclude-standard"],
				{ cwd: root },
			)
		)
			.split("\n")
			.filter(Boolean);
		for (const c of specCoupling(plan, tickets, root, files)) {
			const id = JSON.stringify(c);
			if (seen.has(id)) continue;
			seen.add(id);
			coupling.push(c);
		}
	}
	if (json) io.out(JSON.stringify({ coupling }));
	else {
		for (const f of couplingWarnings(coupling))
			io.out(`${f.level.padEnd(5)}  ${f.rule.padEnd(12)} ${f.message}`);
		io.out(
			coupling.length
				? `${coupling.length} coupling(s): bring them to the spec review`
				: "ok: no spec reaches a child its owner does not need",
		);
	}
	return EXIT.OK;
}

export const planCommand: Command = async (args, io) => {
	const [sub, rawKey] = args;
	const key = rawKey?.toUpperCase();
	const out = flag(args, "--out");
	const from = flag(args, "--from");
	if (key && sub === "specs")
		return specsCommand(key, flag(args, "--dir"), args.includes("--json"), io);
	if (key && sub === "page" && out)
		return pageCommand(key, out, args.includes("--json"), io);
	if (key && sub === "link" && args[2]) return linkCommand(key, args[2], io);
	if (!key || !((sub === "context" && out) || (sub === "write" && from)))
		throw new PortiaProblem(USAGE);
	const { profile, tracker } = await cliContext();
	const files = await repoFiles(realExec, process.cwd());
	// Read-only: the run directory is not created.
	const rows = readRows(runPath(key)).rows;
	if (sub === "context") {
		const ctx = await planContext(
			tracker,
			key,
			topLevelOf(files),
			profile,
			rows,
		);
		writeFileSync(out as string, `${JSON.stringify(ctx, null, "\t")}\n`);
		io.out(
			`${ctx.parent.key}: ${ctx.children.length} to plan, ${ctx.done.length} done, ${ctx.excluded.length} excluded -> ${out}`,
		);
		return EXIT.OK;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(from as string, "utf8"));
	} catch (e) {
		throw new PortiaProblem(
			`could not read the plan file ${from}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const checked = await validatePlan(tracker, key, raw, files, profile, rows);
	const ripples = planRipples(checked, files, profile, process.cwd());
	const plan = {
		...checked,
		findings: [...checked.findings, ...rippleWarnings(ripples)],
	};
	if (!args.includes("--json")) {
		await writePlan(tracker, plan, io.out, isDryRun());
		return EXIT.OK;
	}
	await writePlan(tracker, plan, () => {}, isDryRun());
	io.out(
		JSON.stringify({ findings: plan.findings, lanes: plan.lanes, ripples }),
	);
	return EXIT.OK;
};
