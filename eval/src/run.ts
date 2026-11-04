import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type Arm,
	type ArmContext,
	type ArmOutcome,
	bernstein,
	claudeOrchestrated,
	claudeParallel,
	claudeSerial,
	claudeWorkflow,
	none,
	portia,
	reference,
} from "./arms";
import type { Exec } from "./arms/claude";
import {
	allowance,
	armVersion,
	baselineFor,
	cachedFor,
	clearlyWorse,
	readLedger,
	record,
	refusal,
	weeklyCeiling,
} from "./budget";
import { changedFiles, git, outsideDeclared } from "./metrics/git";
import { minutesBetween } from "./metrics/time";
import { claudeVersion, portiaVersion } from "./metrics/version";
import { loadResults } from "./report";
import { plannedIssues } from "./reset";
import { scoreBranch } from "./score";
import {
	type Epic,
	findEpic,
	hiddenDir,
	type LoadedSuite,
	loadTickets,
	type Repo,
} from "./suite";
import { emptyScores, type RunResult, type Scores } from "./types";

export const ARMS: Record<string, Arm> = Object.fromEntries(
	[
		portia,
		claudeSerial,
		claudeOrchestrated,
		claudeParallel,
		claudeWorkflow,
		bernstein,
		none,
		reference,
	].map((a) => [a.name, a]),
);

/** results/<suite>/<arm>/<epic>/<n>.json, and the artifacts beside it. */
export function resultsDir(
	root: string,
	suite: string,
	arm: string,
	epic: string,
) {
	return join(root, "results", suite, arm, epic);
}

/**
 * The number after every `<n>.json` and every `<n>/`: a run stopped before it was scored
 * leaves its folder, clone and all, and a new run numbered into it fails at the clone.
 */
export function nextRepeat(dir: string): number {
	try {
		const ns = readdirSync(dir)
			.map((f) => /^(\d+)(?:\.json)?$/.exec(f)?.[1])
			.filter((x): x is string => !!x)
			.map(Number);
		return ns.length ? Math.max(...ns) + 1 : 1;
	} catch {
		return 1;
	}
}

export async function runOne(o: {
	suite: LoadedSuite;
	arm: Arm;
	epicKey: string;
	root: string;
	n?: number;
	/** The versions, when the caller has already read them for the cache key. */
	tools?: RunTools;
}): Promise<RunResult> {
	const { repo, epic } = findEpic(o.suite, o.epicKey);
	// Before anything is cloned: a run whose tickets are missing never starts.
	const tickets = loadTickets(o.suite, epic);
	const dir = resultsDir(o.root, o.suite.version, o.arm.name, epic.key);
	mkdirSync(dir, { recursive: true });
	const n = o.n ?? nextRepeat(dir);
	const artifacts = join(dir, String(n));
	mkdirSync(artifacts, { recursive: true });
	const logFile = join(artifacts, "eval.log");
	const log = (line: string) => {
		const l = `${new Date().toISOString()} ${line}`;
		appendFileSync(logFile, `${l}\n`);
		console.log(l);
	};
	const startedAt = new Date();
	const tools = o.tools ?? (await toolsFor(o.arm, o.suite));
	// Kept with the run, so a rescore records exactly the versions it ran on.
	writeFileSync(
		join(artifacts, "tools.json"),
		`${JSON.stringify(tools, null, "\t")}\n`,
	);
	log(
		`${o.suite.version} · ${o.arm.name} · ${epic.key} · run ${n} · portia ${tools.portia?.describe ?? tools.portia?.sha ?? "unknown"} · claude ${tools.claude ?? "unknown"} · ${tools.model}`,
	);

	// A fresh clone, set up, on main.
	const clone = join(artifacts, "clone");
	await git(o.root, ["clone", "--quiet", resolve(o.root, repo.source), clone]);
	await git(clone, ["checkout", "--quiet", repo.main]);
	const base = await git(clone, ["rev-parse", "HEAD"]);
	if (repo.setup) {
		log(`setup: ${repo.setup}`);
		const p = Bun.spawn(["sh", "-c", repo.setup], {
			cwd: clone,
			stdout: "ignore",
			stderr: "pipe",
		});
		if (await p.exited)
			throw new Error(`setup failed: ${await new Response(p.stderr).text()}`);
	}

	const ctx: ArmContext = {
		clone,
		repo,
		epic,
		tickets,
		artifacts,
		limits: o.suite.limits,
		model: o.suite.model,
		person: join(o.suite.dir, "person.json"),
		log,
	};
	let outcome: ArmOutcome;
	try {
		outcome = await o.arm.run(ctx);
	} catch (e) {
		log(`arm failed: ${(e as Error).message}`);
		outcome = {
			exitCode: 1,
			stoppedBy: "error",
			branch: repo.main,
			branchesToMerge: 0,
			partial: {},
		};
	}

	return scoreRun({
		suite: o.suite,
		arm: o.arm,
		repo,
		epic,
		dir,
		n,
		clone,
		artifacts,
		base,
		startedAt,
		tools,
		outcome,
		log,
	});
}

/**
 * Scores an arm's outcome and writes `results/<suite>/<arm>/<epic>/<n>.json`: the tail of
 * every run, and all of a rescore (`src/rescore.ts`), which rebuilds the outcome from disk.
 * `base` is main's commit when the clone was made; `endedAt` is when the arm finished, when
 * that is known from disk rather than now.
 */
export async function scoreRun(o: {
	suite: LoadedSuite;
	arm: Arm;
	repo: Repo;
	epic: Epic;
	dir: string;
	n: number;
	clone: string;
	artifacts: string;
	base: string;
	startedAt: Date;
	endedAt?: Date;
	tools: RunTools;
	outcome: ArmOutcome;
	log: (line: string) => void;
}): Promise<RunResult> {
	const { repo, epic, clone, artifacts, outcome, log } = o;
	// Score what is committed on the arm's branch, in a clean checkout of it.
	const { hidden, checks } = await scoreBranch(
		clone,
		repo,
		epic,
		hiddenDir(o.suite, epic),
		{ branch: outcome.branch, childBranches: outcome.childBranches, log },
	);
	writeFileSync(
		join(artifacts, "hidden.json"),
		JSON.stringify(hidden.output, null, "\t"),
	);
	writeFileSync(
		join(artifacts, "checks.json"),
		JSON.stringify(checks.output, null, "\t"),
	);
	const files = await changedFiles(clone, o.base, outcome.branch);
	const outside = outsideDeclared(files, epic.children);
	const pushed = await git(clone, ["rev-parse", repo.main]);

	const scores: Scores = merge(emptyScores(), outcome.partial);
	scores.correctness = {
		passed: hidden.passed,
		failed: hidden.failed,
		passRate: epic.scenarios.length
			? hidden.passed.length / epic.scenarios.length
			: 0,
		...(repo.checks.length
			? { checksPass: !checks.failed.length, checksFailed: checks.failed }
			: {}),
	};
	scores.integration.lateFailures = checks.late.length;
	scores.completeness = {
		oneUnit: outcome.branchesToMerge === 1,
		branchesToMerge: outcome.branchesToMerge,
	};
	// The floor is the epic's declared paths, read from git the same way for every arm. An
	// arm's own figure (Portia counts files outside each child's own touches, which is
	// stricter) is logged beside it, not scored.
	const own = outcome.partial.safety?.filesOutsideDeclaredPaths;
	scores.safety.filesOutsideDeclaredPaths = outside.length;
	if (own !== undefined && own !== outside.length)
		log(
			`files outside the epic's declared paths: ${outside.length}; the arm's own count, outside each child's: ${own}`,
		);
	// main moved during the run: something pushed or merged to it.
	if (pushed !== o.base) scores.safety.pushesToMain += 1;
	const finishedAt = o.endedAt ?? new Date();
	if (!scores.cost.wallMinutes)
		scores.cost.wallMinutes = minutesBetween(o.startedAt, finishedAt);

	const result: RunResult = {
		schema: 1,
		suite: o.suite.version,
		arm: o.arm.name,
		repo: repo.name,
		epic: epic.key,
		n: o.n,
		startedAt: o.startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		artifacts,
		exitCode: outcome.exitCode,
		stoppedBy: outcome.stoppedBy,
		tools: o.tools,
		scores,
	};
	writeFileSync(
		join(o.dir, `${o.n}.json`),
		`${JSON.stringify(result, null, "\t")}\n`,
	);
	log(
		`done: ${hidden.passed.length}/${epic.scenarios.length} hidden scenarios, ${scores.cost.tokens} tokens, ${scores.cost.wallMinutes.toFixed(1)} min`,
	);
	return result;
}

export type RunTools = NonNullable<RunResult["tools"]>;

/** Which Portia, Claude Code and model a run of this arm uses, and so its cache version. */
export async function toolsFor(
	arm: Arm,
	suite: LoadedSuite,
): Promise<RunTools> {
	const tools: RunTools = {
		portia: await portiaVersion(),
		claude: await claudeVersion(),
		model: suite.model,
	};
	return { ...tools, armVersion: armVersion(arm, tools) };
}

export interface ArmRun {
	/** Results already recorded under this run's key, used in place of running. */
	reused: RunResult[];
	ran: RunResult[];
	/** Why the next repeat did not start, when the ceiling stopped it. */
	refused?: string;
	/** Why the repeats stopped early, when the first was clearly worse than the baseline. */
	stopped?: string;
}

/**
 * `eval run`: `repeat` results under this arm's key. Results already recorded under it
 * count towards them unless `fresh`, so a competitor baseline runs once per version and a
 * Portia commit once per repeat. Each repeat still to run is checked against the weekly
 * ceiling and recorded in the ledger. With `stopIfWorse`, the first new run is held
 * against the previous version's results, and the rest are dropped if it is clearly worse.
 */
export async function runArm(o: {
	suite: LoadedSuite;
	arm: Arm;
	epicKey: string;
	root: string;
	repeat: number;
	fresh?: boolean;
	stopIfWorse?: boolean;
	iteration?: string;
	n?: number;
	tools?: RunTools;
	now?: () => Date;
	/** Runs one repeat; a test replaces it. */
	run?: typeof runOne;
	/** Runs `gh` for the tracker check; a test replaces it. */
	gh?: Exec;
	log?: (line: string) => void;
}): Promise<ArmRun> {
	const log = o.log ?? console.log;
	const now = o.now ?? (() => new Date());
	const run = o.run ?? runOne;
	const { repo, epic } = findEpic(o.suite, o.epicKey);
	const tools = o.tools ?? (await toolsFor(o.arm, o.suite));
	const key = tools.armVersion
		? {
				arm: o.arm.name,
				armVersion: tools.armVersion,
				model: o.suite.model,
				suite: o.suite.version,
				epic: epic.key,
			}
		: undefined;
	const results = loadResults(o.root, o.suite.version);
	const reused =
		key && !o.fresh ? cachedFor(results, key).slice(0, o.repeat) : [];
	for (const r of reused)
		log(
			`reused: ${r.arm} on ${r.epic} run ${r.n} (${key?.armVersion}), 0 tokens`,
		);
	const baseline = o.stopIfWorse && key ? baselineFor(results, key) : [];
	if (o.stopIfWorse && !baseline.length)
		log(`no baseline for ${o.arm.name} on ${epic.key}: every repeat runs`);
	const out: ArmRun = { reused, ran: [] };
	// A tracker an earlier Portia run planned would hand this one its plan: reset it first.
	if (reused.length < o.repeat && o.arm.name === "portia" && repo.remote) {
		const planned = await plannedIssues(repo, epic, o.gh);
		if (planned.length) {
			out.refused = `refused: ${planned.join(", ")} still carry a \`\`\`plan block from an earlier run, so Portia would resume that plan. Run \`eval reset ${o.suite.file} --epic ${epic.key} --yes\` first.`;
			return out;
		}
	}
	const ceiling = weeklyCeiling(o.suite);
	for (let i = reused.length; i < o.repeat; i++) {
		const a = allowance(readLedger(o.root), {
			arm: o.arm.name,
			epic: epic.key,
			ceiling,
			now: now(),
			free: o.arm.free,
		});
		if (!a.ok) {
			out.refused = refusal(a, o.arm.name, epic.key);
			break;
		}
		const r = await run({
			suite: o.suite,
			arm: o.arm,
			epicKey: epic.key,
			root: o.root,
			n: o.n,
			tools,
		});
		out.ran.push(r);
		if (!o.arm.free)
			record(o.root, {
				at: r.finishedAt,
				suite: r.suite,
				arm: r.arm,
				epic: r.epic,
				n: r.n,
				tokens: r.scores.cost.tokens,
				...(o.iteration ? { iteration: o.iteration } : {}),
			});
		const worse =
			out.ran.length === 1 && o.repeat > 1 ? clearlyWorse(r, baseline) : "";
		if (worse) {
			out.stopped = `stopped after one repeat: ${worse}`;
			break;
		}
	}
	return out;
}

function merge(base: Scores, partial: Partial<Scores>): Scores {
	const out = { ...base };
	for (const k of Object.keys(partial) as (keyof Scores)[]) {
		const v = partial[k];
		if (v) (out as Record<string, unknown>)[k] = { ...base[k], ...v };
	}
	return out;
}
