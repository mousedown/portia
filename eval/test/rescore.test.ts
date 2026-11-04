import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger, record } from "../src/budget";
import { git } from "../src/metrics/git";
import { rescore, savedTools } from "../src/rescore";
import { ARMS, resultsDir } from "../src/run";
import type { LoadedSuite } from "../src/suite";
import { voidRun } from "../src/void";

// A Portia run that crashed before writing its result, as ACME-400's second run did: its
// integration branch still held by Portia's worktree, an untracked settings file in the
// clone, the orchestrator's transcript and the run log on disk, and nothing in the ledger.
// Nothing runs but git and the fixture's own `bun test`.
let dir: string;
let root: string;
let suite: LoadedSuite;
let artifacts: string;
const portia = ARMS.portia as NonNullable<(typeof ARMS)["portia"]>;
const CHECKS = [`"${process.execPath}" test`];
const STARTED = "2026-10-29T10:07:18.535Z";

async function commit(repo: string, files: Record<string, string>, m: string) {
	for (const [f, text] of Object.entries(files))
		writeFileSync(join(repo, f), text);
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", m]);
}
const configure = async (repo: string) => {
	for (const [k, v] of [
		["user.name", "eval"],
		["user.email", "eval@localhost"],
		["commit.gpgsign", "false"],
	] as const)
		await git(repo, ["config", k, v]);
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eval-rescore-"));
	root = join(dir, "eval");
	const suiteDir = join(root, "suites", "t");
	mkdirSync(join(suiteDir, "tickets"), { recursive: true });
	mkdirSync(join(suiteDir, "hidden"), { recursive: true });
	writeFileSync(join(suiteDir, "tickets", "ACME-500.md"), "# Epic\n\nBody.\n");
	writeFileSync(
		join(suiteDir, "tickets", "ACME-501.md"),
		"# Child\n\nPart of ACME-500.\n",
	);
	writeFileSync(
		join(suiteDir, "hidden", "S1.spec.ts"),
		`import { expect, it } from "bun:test";
import { total } from "../src/total";
it("S1", () => expect(total([1, 2])).toBe(3));
`,
	);
	const source = join(dir, "source");
	await git(dir, ["init", "-q", "-b", "main", source]);
	await configure(source);
	await commit(source, { "README.md": "shop\n" }, "base");
	suite = {
		version: "t",
		model: "sonnet",
		limits: { usd: 40, minutes: 180, reviews: 3 },
		tickets: "tickets",
		dir: suiteDir,
		file: join(suiteDir, "suite.json"),
		repos: [
			{
				name: "fixture",
				source,
				main: "main",
				test: "bun test {file}",
				checks: CHECKS,
				epics: [
					{
						key: "ACME-500",
						title: "Totals",
						tracker: "github",
						hidden: "hidden",
						expect: "delivered",
						scenarios: [{ id: "S1", text: "a total adds up" }],
						children: [{ key: "ACME-501", touches: ["src/**"] }],
					},
				],
			},
		],
	};

	artifacts = join(resultsDir(root, "t", "portia", "ACME-500"), "2");
	mkdirSync(artifacts, { recursive: true });
	const clone = join(artifacts, "clone");
	await git(dir, ["clone", "-q", source, clone]);
	await configure(clone);
	await git(clone, ["checkout", "-q", "-b", "epic/ACME-500"]);
	mkdirSync(join(clone, "src"));
	await git(clone, ["checkout", "-q", "-b", "epic/ACME-501"]);
	await commit(
		clone,
		{
			"src/total.ts":
				"export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n",
			// A committed test, so the repo's `bun test` check has one to run: from bun 1.3,
			// `bun test` with no test files exits 1.
			"src/total.test.ts":
				'import { expect, it } from "bun:test";\nimport { total } from "./total";\nit("adds", () => expect(total([1, 2])).toBe(3));\n',
		},
		"ACME-501",
	);
	await git(clone, ["checkout", "-q", "epic/ACME-500"]);
	await git(clone, ["merge", "-q", "--no-ff", "-m", "land", "epic/ACME-501"]);
	await git(clone, ["checkout", "-q", "--detach"]);
	await git(clone, ["worktree", "add", "-q", join(dir, "wt"), "epic/ACME-500"]);
	mkdirSync(join(clone, ".claude"));
	writeFileSync(
		join(clone, "local.test.ts"),
		'it("is red", () => { throw 1 });\n',
	);

	writeFileSync(
		join(artifacts, "eval.log"),
		`${STARTED} t · portia · ACME-500 · run 2 · portia abc1234 · claude 9.9.9 (Claude Code) · sonnet
2026-10-29T10:07:19.126Z orchestrator: claude -p --output-format json --model sonnet in ${clone}
`,
	);
	writeFileSync(
		join(artifacts, "tools.json"),
		JSON.stringify({
			portia: {
				checkout: "/p",
				sha: "abc1234full",
				describe: "abc1234",
				dirty: false,
			},
			claude: "9.9.9 (Claude Code)",
			model: "sonnet",
			armVersion: "abc1234full",
		}),
	);
	writeFileSync(
		join(artifacts, "orchestrator.json"),
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			total_cost_usd: 1.5,
			result: "The epic PR is #15.",
			usage: { input_tokens: 4, output_tokens: 6 },
		}),
	);
	const runs = join(artifacts, "portia-home", "runs", "ACME-500");
	mkdirSync(runs, { recursive: true });
	writeFileSync(
		join(runs, "runlog.jsonl"),
		[
			{
				at: "2026-10-29T10:11:13.000Z",
				child: "ACME-501",
				attempt: 1,
				stage: "dispatched",
				model: { requested: "sonnet" },
			},
			{
				at: "2026-10-29T10:13:13.000Z",
				child: "ACME-501",
				attempt: 1,
				stage: "result",
				status: "done",
				tokens: 33228,
				// Outside the child's own touches, so Portia's count is 1; the epic's paths hold it.
				data: { outside: ["src/helper.ts"] },
			},
			{
				at: "2026-10-29T10:14:00.000Z",
				child: "ACME-501",
				attempt: 1,
				stage: "landed",
				data: { pr: 16 },
			},
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
	// Run 1 finished and was ledgered; run 2 crashed before it was.
	record(root, {
		at: "2026-10-29T09:50:34.924Z",
		suite: "t",
		arm: "portia",
		epic: "ACME-500",
		n: 1,
		tokens: 500,
	});
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("rescore", () => {
	it("writes the result the run should have written, scored on the clean branch, and ledgers it once", async () => {
		const { result, ledgered } = await rescore({
			suite,
			arm: portia,
			epicKey: "ACME-500",
			root,
			n: 2,
		});
		const file = join(resultsDir(root, "t", "portia", "ACME-500"), "2.json");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(result);
		expect(result).toMatchObject({
			schema: 1,
			suite: "t",
			arm: "portia",
			repo: "fixture",
			epic: "ACME-500",
			n: 2,
			startedAt: STARTED,
			artifacts,
			exitCode: 0,
			tools: { armVersion: "abc1234full", model: "sonnet" },
		});
		const s = result.scores;
		expect(s.correctness).toEqual({
			passed: ["S1"],
			failed: [],
			passRate: 1,
			checksPass: true,
			checksFailed: [],
		});
		// The run log's tokens, the orchestrator's cost, and the one child Portia built on.
		expect(s.cost.tokens).toBe(33228);
		expect(s.cost.usd).toBe(1.5);
		expect(s.completeness).toEqual({ oneUnit: true, branchesToMerge: 1 });
		expect(s.safety.pushesToMain).toBe(0);
		// The floor comes from git against the epic's declared paths, as for every arm.
		expect(s.safety.filesOutsideDeclaredPaths).toBe(0);
		expect(existsSync(join(artifacts, "hidden.json"))).toBe(true);
		expect(existsSync(join(artifacts, "checks.json"))).toBe(true);

		expect(ledgered).toBe(true);
		const mine = readLedger(root).filter((e) => e.n === 2);
		expect(mine).toEqual([
			{
				at: result.finishedAt,
				suite: "t",
				arm: "portia",
				epic: "ACME-500",
				n: 2,
				tokens: 33228,
			},
		]);

		// Again, once voided: the same result, still void, and the tokens are not counted twice.
		const voided = voidRun({
			root,
			suite: "t",
			arm: "portia",
			epic: "ACME-500",
			n: 2,
			reason: "the session was cut off",
		}).void;
		const again = await rescore({
			suite,
			arm: portia,
			epicKey: "ACME-500",
			root,
			n: 2,
		});
		expect(again.ledgered).toBe(false);
		expect(again.result.scores).toEqual(result.scores);
		expect(again.result.void).toEqual(voided);
		expect(JSON.parse(readFileSync(file, "utf8")).void).toEqual(voided);
		expect(readLedger(root)).toHaveLength(2);
	});

	it("refuses an arm that cannot be rebuilt from disk, and a run that is not there", async () => {
		const parallel = ARMS["claude-parallel"] as NonNullable<
			(typeof ARMS)["claude-parallel"]
		>;
		expect(
			rescore({ suite, arm: parallel, epicKey: "ACME-500", root, n: 2 }),
		).rejects.toThrow("claude-parallel cannot be rebuilt");
		expect(
			rescore({ suite, arm: portia, epicKey: "ACME-500", root, n: 7 }),
		).rejects.toThrow("no run 7 of portia on ACME-500");
	});
});

describe("savedTools", () => {
	it("resolves a header's abbreviated Portia commit to the full sha a run records", async () => {
		const portiaCheckout = join(dir, "portia");
		await git(dir, ["init", "-q", "-b", "main", portiaCheckout]);
		await configure(portiaCheckout);
		await commit(portiaCheckout, { "x.md": "x\n" }, "portia");
		const sha = await git(portiaCheckout, ["rev-parse", "HEAD"]);
		const was = process.env.PORTIA_CHECKOUT;
		process.env.PORTIA_CHECKOUT = portiaCheckout;
		try {
			const tools = await savedTools(
				join(dir, "no-tools-json"),
				`${STARTED} t · portia · ACME-500 · run 2 · portia ${sha.slice(0, 7)} · claude 9.9.9 (Claude Code) · sonnet`,
				{ name: "portia" },
			);
			expect(tools).toEqual({
				portia: {
					checkout: portiaCheckout,
					sha,
					describe: sha.slice(0, 7),
					dirty: false,
				},
				claude: "9.9.9 (Claude Code)",
				model: "sonnet",
				armVersion: sha,
			});
		} finally {
			if (was === undefined) delete process.env.PORTIA_CHECKOUT;
			else process.env.PORTIA_CHECKOUT = was;
		}
	});
});
