import { join } from "node:path";
import { nodeFs } from "../view/model/fs";
import { runKeys } from "../view/model/home";
import { readRun } from "../view/model/run";
import type { RunView, Source } from "../view/model/types";
import { PortiaProblem } from "./exit";
import { portiaHome, runPath } from "./rundir";
import { readRows } from "./runlog";
import type { ChildPlan, ParentPlan, RunRow } from "./types";

export interface Run {
	key: string;
	dir: string;
	rows: RunRow[];
	/** Run log lines that did not parse. */
	skipped: number;
	plan: ParentPlan;
	/** Where the plan came from: `plan.json`, else the ledger, else the run log's children. */
	source: Source;
	/** Why this run reads less than a full one: no plan snapshot, or unreadable log lines. */
	warnings: string[];
}

/** The plan `portia view` shows: its snapshot, else the one it rebuilt from the ledger or the run log. */
function viewedPlan(view: RunView): ParentPlan {
	if (view.plan) return view.plan;
	const children: ChildPlan[] = view.children.map((c) => ({
		key: c.key,
		summary: c.summary,
		wave: c.wave,
		needs: [],
		touches: c.touches ?? [],
		requirements: c.requirements.map((r) => r.id),
		evidence: "",
		tier: "standard",
		acceptance: {},
		blockedBy: [],
	}));
	const closed = view.children
		.filter((c) => c.state === "closed")
		.map((c) => c.key);
	return {
		key: view.key,
		summary: view.summary ?? "",
		scope: view.scope ?? "",
		scenarios: [],
		children,
		...(closed.length ? { closed } : {}),
	};
}

/** One run: its rows, its plan (falling back as `portia view` does) and its directory. */
export function loadRun(
	key: string,
	env: Record<string, string | undefined> = process.env,
	now = Date.now(),
): Run {
	const home = portiaHome(env);
	const dir = runPath(key, env);
	const view = readRun(nodeFs, home, key.toUpperCase(), now);
	const { rows, skipped } = readRows(dir);
	const warnings: string[] = [];
	if (view.source !== "plan")
		warnings.push(
			`${view.key}: no plan.json; its children come from the ${view.source === "ledger" ? "ledger" : "run log"}`,
		);
	if (skipped)
		warnings.push(`${view.key}: ${skipped} unreadable run log line(s)`);
	return {
		key: view.key,
		dir,
		rows,
		skipped,
		plan: viewedPlan(view),
		source: view.source,
		warnings,
	};
}

/**
 * Every run under the Portia home, or only the named parents. A run whose plan cannot be
 * loaded is listed with a warning rather than skipped; a named parent with no run is a problem.
 */
export function listRuns(
	keys: string[] = [],
	env: Record<string, string | undefined> = process.env,
	now = Date.now(),
): Run[] {
	const home = portiaHome(env);
	const all = runKeys(nodeFs, home);
	const wanted = keys.length ? keys.map((k) => k.toUpperCase()) : all;
	for (const k of wanted)
		if (!all.includes(k))
			throw new PortiaProblem(`no run ${k} in ${join(home, "runs")}`);
	return wanted.map((k) => loadRun(k, env, now));
}
