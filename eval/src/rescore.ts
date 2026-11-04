import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Arm, ArmContext } from "./arms";
import { armVersion, readLedger, record } from "./budget";
import { git } from "./metrics/git";
import { portiaVersion } from "./metrics/version";
import { type RunTools, resultsDir, scoreRun } from "./run";
import { findEpic, type LoadedSuite, loadTickets } from "./suite";
import type { RunResult } from "./types";

/**
 * `eval rescore`: scores a run that already happened, from what it left on disk, and writes
 * the result it should have written (`results/<suite>/<arm>/<epic>/<n>.json`, as `runOne`
 * does). Nothing runs: the arm rebuilds its outcome from its transcripts, run state and the
 * clone's branches (`Arm.rebuild`), and the clone is scored as a finished run's is. Nothing
 * is spent, so the ledger only gains the run's tokens when it never got them (a run that
 * crashed before its result was written), and then once.
 */
export async function rescore(o: {
	suite: LoadedSuite;
	arm: Arm;
	epicKey: string;
	root: string;
	n: number;
	iteration?: string;
}): Promise<{ result: RunResult; ledgered: boolean }> {
	const { repo, epic } = findEpic(o.suite, o.epicKey);
	if (!o.arm.rebuild)
		throw new Error(
			`${o.arm.name} cannot be rebuilt from what its run left on disk, so it cannot be rescored: run it again`,
		);
	const dir = resultsDir(o.root, o.suite.version, o.arm.name, epic.key);
	const artifacts = join(dir, String(o.n));
	const clone = join(artifacts, "clone");
	const runLog = join(artifacts, "eval.log");
	if (!existsSync(clone) || !existsSync(runLog))
		throw new Error(
			`no run ${o.n} of ${o.arm.name} on ${epic.key}: expected its clone and eval.log in ${artifacts}`,
		);
	const header = readFileSync(runLog, "utf8").split("\n")[0] ?? "";
	const startedAt = new Date(header.split(" ")[0] ?? "");
	if (Number.isNaN(startedAt.getTime()))
		throw new Error(`${runLog} does not start with the run's header line`);
	const tools = await savedTools(artifacts, header, o.arm);
	// Its own log, so eval.log stays the record of the run itself.
	const logFile = join(artifacts, "rescore.log");
	const log = (line: string) => {
		const l = `${new Date().toISOString()} ${line}`;
		appendFileSync(logFile, `${l}\n`);
		console.log(l);
	};
	log(`rescore: ${o.suite.version} · ${o.arm.name} · ${epic.key} · run ${o.n}`);

	const ctx: ArmContext = {
		clone,
		repo,
		epic,
		tickets: loadTickets(o.suite, epic),
		artifacts,
		limits: o.suite.limits,
		model: o.suite.model,
		person: join(o.suite.dir, "person.json"),
		log,
	};
	const outcome = await o.arm.rebuild(ctx);
	const saved = join(dir, `${o.n}.json`);
	const voided: RunResult["void"] = existsSync(saved)
		? JSON.parse(readFileSync(saved, "utf8")).void
		: undefined;
	const scored = await scoreRun({
		suite: o.suite,
		arm: o.arm,
		repo,
		epic,
		dir,
		n: o.n,
		clone,
		artifacts,
		base: await mainAtClone(clone, repo.main),
		startedAt,
		endedAt: endedAt(artifacts) ?? startedAt,
		tools,
		outcome,
		log,
	});
	// A void run stays void when it is scored again.
	const result = voided ? { ...scored, void: voided } : scored;
	if (voided) writeFileSync(saved, `${JSON.stringify(result, null, "\t")}\n`);

	const ledgered =
		!o.arm.free &&
		!readLedger(o.root).some(
			(e) =>
				e.suite === result.suite &&
				e.arm === result.arm &&
				e.epic === result.epic &&
				e.n === result.n,
		);
	if (ledgered)
		record(o.root, {
			at: result.finishedAt,
			suite: result.suite,
			arm: result.arm,
			epic: result.epic,
			n: result.n,
			tokens: result.scores.cost.tokens,
			...(o.iteration ? { iteration: o.iteration } : {}),
		});
	return { result, ledgered };
}

/**
 * The versions the run recorded: `tools.json`, which every run now keeps, else its log's
 * header (`portia <describe> · claude <version> · <model>`), with Portia's abbreviated
 * commit resolved in the Portia checkout so the cache key is the full sha a run records.
 */
export async function savedTools(
	artifacts: string,
	header: string,
	arm: { name: string; version?: string },
): Promise<RunTools> {
	const file = join(artifacts, "tools.json");
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
	const m = / · portia (\S+) · claude (.+) · (\S+)$/.exec(header);
	if (!m)
		throw new Error(
			`no tools.json in ${artifacts}, and its eval.log header names no versions`,
		);
	const [, describe = "", claude = "", model = ""] = m;
	const tools: RunTools = {
		...(describe === "unknown"
			? {}
			: { portia: await resolvedPortia(describe) }),
		...(claude === "unknown" ? {} : { claude }),
		model,
	};
	return { ...tools, armVersion: armVersion(arm, tools) };
}

async function resolvedPortia(
	describe: string,
): Promise<NonNullable<RunTools["portia"]>> {
	const { checkout } = await portiaVersion();
	if (!checkout)
		throw new Error(
			`the run used Portia ${describe}, and there is no Portia checkout to resolve it in: set PORTIA_CHECKOUT`,
		);
	const dirty = describe.endsWith("-dirty");
	const rev = describe.replace(/-dirty$/, "");
	let sha: string;
	try {
		sha = await git(checkout, ["rev-parse", "--verify", `${rev}^{commit}`]);
	} catch {
		throw new Error(`Portia ${describe} is not a commit in ${checkout}`);
	}
	return { checkout, sha, describe, dirty };
}

/** main's commit when the clone was made: the oldest entry in its reflog. */
async function mainAtClone(clone: string, main: string): Promise<string> {
	const out = await git(clone, [
		"reflog",
		"show",
		"--format=%H",
		`refs/heads/${main}`,
	]);
	const sha = out.split("\n").filter(Boolean).at(-1);
	if (!sha) throw new Error(`${clone} has no reflog for ${main}`);
	return sha;
}

/** When the arm finished: the last session transcript's last write. */
function endedAt(artifacts: string): Date | undefined {
	const scored = new Set(["hidden.json", "checks.json", "tools.json"]);
	const times = readdirSync(artifacts)
		.filter((f) => f.endsWith(".json") && !scored.has(f))
		.map((f) => statSync(join(artifacts, f)).mtime.getTime());
	return times.length ? new Date(Math.max(...times)) : undefined;
}
