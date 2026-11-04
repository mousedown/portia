#!/usr/bin/env bun
// The eval harness: run an arm on an epic, or report over what has been run.
//   bun run eval run suites/v1/suite.json --arm portia --epic ACME-500 --repeat 3
//   bun run eval run suites/v1/suite.json --arm claude-serial --epic ACME-500   -> reused when cached
//   bun run eval run suites/v1/suite.json --arm portia --epic ACME-500 --repeat 3 --stop-if-worse
//   bun run eval preflight suites/v1/suite.json --arm portia --epic ACME-400  -> setup checked, cents spent
//   bun run eval queue suites/v1/suite.json --arm portia --epic ACME-500 --repeat 3
//   bun run eval queue                                  -> what is waiting
//   bun run eval drain                                  -> runs it, one at a time, within the ceiling
//   bun run eval report suites/v1/suite.json            -> results/<version>.json and .md
//   bun run eval changelog suites/v1/suite.json --iteration 1
//   bun run eval compare suites/v1/suite.json --before <sha> --after <sha> [--arm portia]
//   bun run eval rescore suites/v1/suite.json --arm portia --epic ACME-400 --n 2  -> scored from disk, nothing run
//   bun run eval reset suites/v1/suite.json --epic ACME-400 [--yes]  -> the tracker as filed, dry run without --yes
//   bun run eval void suites/v1/suite.json --arm portia --epic ACME-400 --n 1 --reason "…"  -> left out of report, compare and cache
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	allowance,
	changelogTokens,
	readLedger,
	readQueue,
	tokensMarkdown,
	weeklyCeiling,
	writeQueue,
} from "./budget";
import { compareVersions, comparisonMarkdown } from "./compare";
import { preflight } from "./preflight";
import { aggregate, loadResults, markdown } from "./report";
import { rescore } from "./rescore";
import { applyReset, loadProfile, resetPlan } from "./reset";
import { ARMS, type ArmRun, runArm } from "./run";
import { findEpic, loadSuite, loadTickets } from "./suite";
import { voidRun } from "./void";

const USAGE = `usage: eval run <suite.json> --arm <${Object.keys(ARMS).join("|")}> --epic KEY [--repeat N] [--n N] [--fresh] [--stop-if-worse] [--iteration I]
       eval preflight <suite.json> --arm A --epic KEY
       eval queue [<suite.json> --arm A --epic KEY [--repeat N] [--fresh] [--stop-if-worse] [--iteration I]]
       eval drain
       eval report <suite.json>
       eval changelog <suite.json> --iteration I
       eval compare <suite.json> --before <sha> --after <sha> [--arm portia]
       eval rescore <suite.json> --arm A --epic KEY --n N [--iteration I]
       eval reset <suite.json> --epic KEY [--yes]
       eval void <suite.json> --arm A --epic KEY --n N --reason "<why>"
       eval arms`;

const [cmd, ...rest] = process.argv.slice(2);
const root = process.cwd();
const flag = (name: string): string | undefined => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(name);
const armOf = (name: string) =>
	ARMS[name] ?? fail(`no arm ${name}; one of ${Object.keys(ARMS).join(", ")}`);

/** One line per result, reused or run, then why it stopped early, if it did. */
function show(r: ArmRun) {
	for (const x of [...r.reused, ...r.ran])
		console.log(
			JSON.stringify({
				arm: x.arm,
				epic: x.epic,
				n: x.n,
				reused: r.reused.includes(x),
				passRate: x.scores.correctness.passRate,
				tokens: r.reused.includes(x) ? 0 : x.scores.cost.tokens,
			}),
		);
	if (r.stopped) console.log(r.stopped);
	if (r.refused) console.error(r.refused);
}

if (cmd === "arms") {
	for (const a of Object.values(ARMS))
		console.log(`${a.name.padEnd(20)} ${a.description}`);
} else if (cmd === "run") {
	const file = rest[0];
	const armName = flag("--arm");
	const epic = flag("--epic");
	if (!file || !armName || !epic) fail(USAGE);
	const fixed = flag("--n");
	const r = await runArm({
		suite: loadSuite(file),
		arm: armOf(armName),
		epicKey: epic,
		root,
		repeat: Number(flag("--repeat") ?? 1),
		fresh: has("--fresh"),
		stopIfWorse: has("--stop-if-worse"),
		iteration: flag("--iteration"),
		n: fixed ? Number(fixed) : undefined,
	});
	show(r);
	if (r.refused) process.exit(1);
} else if (cmd === "preflight") {
	const file = rest[0];
	const armName = flag("--arm");
	const epic = flag("--epic");
	if (!file || !armName || !epic) fail(USAGE);
	const checks = await preflight({
		suite: loadSuite(file),
		arm: armOf(armName),
		epicKey: epic,
		root,
	});
	for (const c of checks)
		console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(28)} ${c.detail}`);
	if (checks.some((c) => !c.ok)) process.exit(1);
} else if (cmd === "queue") {
	const queue = readQueue(root);
	const file = rest[0];
	if (file && !file.startsWith("--")) {
		const arm = flag("--arm") ?? fail(USAGE);
		const epic = flag("--epic") ?? fail(USAGE);
		armOf(arm);
		queue.push({
			suite: resolve(file),
			arm,
			epic,
			repeat: Number(flag("--repeat") ?? 1),
			...(has("--fresh") ? { fresh: true } : {}),
			...(has("--stop-if-worse") ? { stopIfWorse: true } : {}),
			...(flag("--iteration") ? { iteration: flag("--iteration") } : {}),
			addedAt: new Date().toISOString(),
		});
		writeQueue(root, queue);
	}
	if (!queue.length) console.log("nothing queued");
	const ledger = readLedger(root);
	for (const [i, q] of queue.entries()) {
		const a = allowance(ledger, {
			arm: q.arm,
			epic: q.epic,
			ceiling: weeklyCeiling(loadSuite(q.suite)),
			now: new Date(),
			free: ARMS[q.arm]?.free,
		});
		console.log(
			`${i + 1}. ${q.arm} on ${q.epic} × ${q.repeat}${q.fresh ? " fresh" : ""}${q.stopIfWorse ? " stop-if-worse" : ""}${q.iteration ? ` (iteration ${q.iteration})` : ""}: ${a.expected === undefined ? "no estimate" : `~${a.expected.toLocaleString("en-GB")} tokens a run`}, ${a.ok ? "fits this week" : "waits for next week"}`,
		);
	}
} else if (cmd === "drain") {
	// One queued run at a time, oldest first. The first one the ceiling refuses stays at
	// the head of the queue, with the rest behind it, for the next scheduled drain.
	const queue = readQueue(root);
	while (queue.length) {
		const q = queue[0];
		if (!q) break;
		const r = await runArm({
			suite: loadSuite(q.suite),
			arm: armOf(q.arm),
			epicKey: q.epic,
			root,
			repeat: q.repeat,
			fresh: q.fresh,
			stopIfWorse: q.stopIfWorse,
			iteration: q.iteration,
		});
		show(r);
		if (r.refused) {
			// Reused results already count towards a cached run; a fresh one keeps only what is left.
			if (q.fresh) q.repeat -= r.ran.length;
			writeQueue(root, queue);
			break;
		}
		queue.shift();
		writeQueue(root, queue);
	}
	console.log(`${queue.length} run(s) still queued`);
} else if (cmd === "changelog") {
	const file = rest[0] ?? fail(USAGE);
	const iteration = flag("--iteration") ?? fail(USAGE);
	console.log(
		changelogTokens(
			readLedger(root),
			iteration,
			weeklyCeiling(loadSuite(file)),
		),
	);
} else if (cmd === "report") {
	const file = rest[0] ?? fail(USAGE);
	const suite = loadSuite(file);
	const results = loadResults(root, suite.version);
	if (!results.length) fail(`no results under results/${suite.version}`);
	const report = aggregate(results, suite.version);
	mkdirSync(join(root, "results"), { recursive: true });
	writeFileSync(
		join(root, "results", `${suite.version}.json`),
		`${JSON.stringify(report, null, "\t")}\n`,
	);
	const md = `${markdown(report)}\n${tokensMarkdown(readLedger(root), weeklyCeiling(suite))}`;
	writeFileSync(join(root, "results", `${suite.version}.md`), md);
	console.log(md);
} else if (cmd === "rescore") {
	const file = rest[0];
	const armName = flag("--arm");
	const epic = flag("--epic");
	const n = Number(flag("--n"));
	if (!file || !armName || !epic || !(n > 0)) fail(USAGE);
	const { result: x, ledgered } = await rescore({
		suite: loadSuite(file),
		arm: armOf(armName),
		epicKey: epic,
		root,
		n,
		iteration: flag("--iteration"),
	});
	const s = x.scores;
	console.log(
		JSON.stringify({
			arm: x.arm,
			epic: x.epic,
			n: x.n,
			passRate: s.correctness.passRate,
			passed: s.correctness.passed,
			checksPass: s.correctness.checksPass,
			checksFailed: s.correctness.checksFailed,
			lateFailures: s.integration.lateFailures,
			filesOutsideDeclaredPaths: s.safety.filesOutsideDeclaredPaths,
			tokens: s.cost.tokens,
			usd: s.cost.usd,
			ledgered,
		}),
	);
} else if (cmd === "reset") {
	const file = rest[0];
	const epicKey = flag("--epic");
	if (!file || !epicKey) fail(USAGE);
	const suite = loadSuite(file);
	const { repo, epic } = findEpic(suite, epicKey);
	const t = loadTickets(suite, epic);
	const steps = await resetPlan({
		suite,
		epicKey,
		profile: await loadProfile(repo.name),
		tickets: { [epic.key]: t.epic, ...t.children },
	});
	const apply = has("--yes");
	for (const s of steps) console.log(`${apply ? "" : "would "}${s.what}`);
	if (!steps.some((s) => s.cmd.length)) console.log("nothing to reset");
	else if (apply) await applyReset(steps);
	else console.log("dry run: pass --yes to apply");
} else if (cmd === "void") {
	const file = rest[0];
	const armName = flag("--arm");
	const epic = flag("--epic");
	const n = Number(flag("--n"));
	const reason = flag("--reason");
	if (!file || !armName || !epic || !(n > 0) || !reason) fail(USAGE);
	const x = voidRun({
		root,
		suite: loadSuite(file).version,
		arm: armOf(armName).name,
		epic,
		n,
		reason,
	});
	console.log(
		JSON.stringify({ arm: x.arm, epic: x.epic, n: x.n, void: x.void }),
	);
} else if (cmd === "compare") {
	const file = rest[0] ?? fail(USAGE);
	const before = flag("--before") ?? fail(USAGE);
	const after = flag("--after") ?? fail(USAGE);
	const suite = loadSuite(file);
	const c = compareVersions(
		loadResults(root, suite.version),
		flag("--arm") ?? "portia",
		before,
		after,
	);
	console.log(comparisonMarkdown(c));
} else fail(USAGE);

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}
