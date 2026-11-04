import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/arms/claude";
import {
	allowance,
	armVersion,
	baselineFor,
	cachedFor,
	changelogTokens,
	clearlyWorse,
	expectedTokens,
	isoDate,
	type LedgerEntry,
	ledgerFile,
	readLedger,
	readQueue,
	record,
	tokensMarkdown,
	weeklyCeiling,
	weekStart,
} from "../src/budget";
import { ARMS, runArm, type runOne } from "../src/run";
import { loadSuite } from "../src/suite";
import { emptyScores, type RunResult } from "../src/types";

// Nothing here runs an arm: `eval run` is refused or reuses a result before it would clone,
// and where a run has to happen a fake stands in for it. A fake `claude` on PATH answers
// `--version`, so the cache key is the same in the test and in the spawned CLI.
const SUITE = join(import.meta.dir, "../suites/v1/suite.json");
const CLAUDE = "9.9.9 (Claude Code)";
const TOOLS = {
	claude: CLAUDE,
	model: "sonnet",
	armVersion: `1 · claude ${CLAUDE}`,
};
const DAY = 86_400_000;

const entry = (o: Partial<LedgerEntry> & { at: string }): LedgerEntry => ({
	suite: "v1",
	arm: "portia",
	epic: "ACME-500",
	n: 1,
	tokens: 750_000,
	...o,
});

const result = (o: {
	arm?: string;
	n: number;
	armVersion?: string;
	passRate?: number;
	tokenShare?: number;
	tokens?: number;
	finishedAt?: string;
}): RunResult => {
	const scores = emptyScores();
	scores.correctness.passRate = o.passRate ?? 1;
	scores.rework.tokenShare = o.tokenShare ?? 0;
	scores.cost.tokens = o.tokens ?? 700_000;
	return {
		schema: 1,
		suite: "v1",
		arm: o.arm ?? "claude-serial",
		repo: "acme-shop",
		epic: "ACME-500",
		n: o.n,
		startedAt: "2026-10-21T08:00:00Z",
		finishedAt: o.finishedAt ?? "2026-10-21T09:00:00Z",
		artifacts: "",
		exitCode: 0,
		tools: { ...TOOLS, armVersion: o.armVersion ?? TOOLS.armVersion },
		scores,
	};
};

const save = (root: string, r: RunResult) => {
	const d = join(root, "results", r.suite, r.arm, r.epic);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, `${r.n}.json`), JSON.stringify(r));
};

describe("the weekly ceiling", () => {
	const wed = new Date("2026-10-28T15:00:00Z");
	it("weeks start on Monday, UTC", () => {
		expect(isoDate(weekStart(wed))).toBe("2026-10-26");
		expect(isoDate(weekStart(new Date("2026-10-26T00:00:00Z")))).toBe(
			"2026-10-26",
		);
		expect(isoDate(weekStart(new Date("2026-11-01T23:59:00Z")))).toBe(
			"2026-10-26",
		);
	});

	it("is 3M, set in the suite, and the environment overrides both", () => {
		expect(weeklyCeiling({}, {})).toBe(3_000_000);
		expect(weeklyCeiling({ budget: { weeklyTokens: 2_000_000 } }, {})).toBe(
			2_000_000,
		);
		expect(
			weeklyCeiling(
				{ budget: { weeklyTokens: 2_000_000 } },
				{ EVAL_WEEKLY_TOKENS: "500000" },
			),
		).toBe(500_000);
	});

	it("expects a run to cost what that arm's runs on that epic cost", () => {
		const ledger = [
			entry({ at: "2026-10-20T10:00:00Z", tokens: 600_000 }),
			entry({ at: "2026-10-21T10:00:00Z", tokens: 800_000 }),
			entry({ at: "2026-10-21T10:00:00Z", epic: "ACME-501", tokens: 2e6 }),
		];
		expect(expectedTokens(ledger, "portia", "ACME-500")).toBe(700_000);
		expect(expectedTokens(ledger, "portia", "ACME-502")).toBeCloseTo(
			1.13e6,
			-4,
		);
		expect(expectedTokens(ledger, "claude-serial", "ACME-500")).toBeUndefined();
	});

	it("refuses a run that would cross it, and names next Monday", () => {
		const ledger = [
			entry({ at: "2026-10-26T09:00:00Z", tokens: 1_500_000 }),
			entry({ at: "2026-10-27T09:00:00Z", tokens: 1_000_000 }),
		];
		const a = allowance(ledger, {
			arm: "portia",
			epic: "ACME-500",
			ceiling: 3_000_000,
			now: wed,
		});
		expect(a).toMatchObject({ ok: false, spent: 2_500_000, expected: 1.25e6 });
		expect(a.runsOn && isoDate(a.runsOn)).toBe("2026-11-02");
		// Last week's spend does not count against this one.
		expect(
			allowance(ledger, {
				arm: "portia",
				epic: "ACME-500",
				ceiling: 3_000_000,
				now: new Date("2026-11-02T00:00:00Z"),
			}).ok,
		).toBe(true);
	});

	it("never fits a run bigger than a whole week, and never holds back a free arm", () => {
		const ledger = [entry({ at: "2026-10-01T09:00:00Z", tokens: 4e6 })];
		const big = allowance(ledger, {
			arm: "portia",
			epic: "ACME-500",
			ceiling: 3e6,
			now: wed,
		});
		expect(big.ok).toBe(false);
		expect(big.runsOn).toBeUndefined();
		const full = [entry({ at: "2026-10-27T09:00:00Z", tokens: 3e6 })];
		expect(
			allowance(full, { arm: "none", epic: "ACME-500", ceiling: 3e6, now: wed })
				.ok,
		).toBe(false);
		expect(
			allowance(full, {
				arm: "none",
				epic: "ACME-500",
				ceiling: 3e6,
				now: wed,
				free: true,
			}).ok,
		).toBe(true);
		expect(ARMS.none?.free && ARMS.reference?.free).toBe(true);
	});
});

describe("the result cache", () => {
	it("keys a competitor by its revision and Claude Code, and Portia by a clean commit", () => {
		expect(armVersion({ name: "claude-serial" }, { claude: CLAUDE })).toBe(
			TOOLS.armVersion,
		);
		expect(
			armVersion({ name: "claude-serial", version: "2" }, { claude: CLAUDE }),
		).toBe(`2 · claude ${CLAUDE}`);
		expect(armVersion({ name: "claude-serial" }, {})).toBeUndefined();
		expect(
			armVersion(
				{ name: "portia" },
				{ claude: CLAUDE, portia: { sha: "abc" } },
			),
		).toBe("abc");
		expect(
			armVersion(
				{ name: "portia" },
				{ portia: { sha: "abc", dirty: true }, claude: CLAUDE },
			),
		).toBeUndefined();
	});

	it("matches every part of the key, and the baseline is the latest other version", () => {
		const rs = [
			result({ n: 1 }),
			result({ n: 2, armVersion: "old", finishedAt: "2026-10-01T00:00:00Z" }),
			result({ n: 3, armVersion: "older", finishedAt: "2026-09-01T00:00:00Z" }),
			result({ n: 4, arm: "claude-parallel" }),
		];
		const key = {
			arm: "claude-serial",
			armVersion: TOOLS.armVersion,
			model: "sonnet",
			suite: "v1",
			epic: "ACME-500",
		};
		expect(cachedFor(rs, key).map((r) => r.n)).toEqual([1]);
		expect(cachedFor(rs, { ...key, model: "opus" })).toEqual([]);
		expect(cachedFor(rs, { ...key, suite: "v2" })).toEqual([]);
		expect(baselineFor(rs, key).map((r) => r.n)).toEqual([2]);
	});
});

describe("clearlyWorse", () => {
	const base = [
		result({ n: 1, passRate: 0.875, tokenShare: 0.1 }),
		result({ n: 2, passRate: 1, tokenShare: 0.2 }),
	];
	it("is below the baseline's worst on correctness, or above it on rework", () => {
		expect(clearlyWorse(result({ n: 3, passRate: 0.5 }), base)).toContain(
			"below the baseline's worst 88%",
		);
		expect(
			clearlyWorse(result({ n: 3, passRate: 1, tokenShare: 0.4 }), base),
		).toContain("rework share of tokens 40%");
		expect(
			clearlyWorse(result({ n: 3, passRate: 0.875, tokenShare: 0.2 }), base),
		).toBeUndefined();
		expect(clearlyWorse(result({ n: 3, passRate: 0 }), [])).toBeUndefined();
	});
});

describe("tokens in the report and the changelog", () => {
	const ledger = [
		entry({ at: "2026-10-20T10:00:00Z", tokens: 600_000, iteration: "0" }),
		entry({ at: "2026-10-27T10:00:00Z", tokens: 900_000, iteration: "1" }),
		entry({ at: "2026-10-28T10:00:00Z", tokens: 700_000, iteration: "1" }),
	];
	it("totals per week and per iteration", () => {
		const md = tokensMarkdown(ledger, 3e6);
		expect(md).toContain("| 2026-10-19 | 600,000 | 1 | 20% |");
		expect(md).toContain("| 2026-10-26 | 1,600,000 | 2 | 53% |");
		expect(md).toContain("| 1 | 1,600,000 | 2 | 800,000 |");
		expect(changelogTokens(ledger, "1", 3e6)).toBe(
			"**Tokens:** 1,600,000 over 2 run(s) in iteration 1; week of 2026-10-26: 1,600,000 (53% of the ceiling).",
		);
	});
});

describe("runArm", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "eval-budget-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/** Stands in for runOne: each call returns the next score, writes the result and counts. */
	const fake = (passRates: number[]) => {
		const calls: number[] = [];
		const run: typeof runOne = async (o) => {
			const n = calls.length + 1;
			calls.push(n);
			const r = result({
				arm: o.arm.name,
				n: 10 + n,
				passRate: passRates[n - 1] ?? 1,
				armVersion: o.tools?.armVersion,
				finishedAt: new Date().toISOString(),
			});
			save(root, r);
			return r;
		};
		return { run, calls };
	};
	const portia = ARMS.portia as NonNullable<(typeof ARMS)["portia"]>;
	const opts = (run: typeof runOne) => ({
		suite: loadSuite(SUITE),
		arm: portia,
		epicKey: "ACME-500",
		root,
		repeat: 3,
		stopIfWorse: true,
		tools: { ...TOOLS, portia: { sha: "new" }, armVersion: "new" },
		run,
		gh: tracker([]),
		log: () => {},
	});
	/** A fake `gh` whose tracker holds these issues, and nothing else. */
	const tracker =
		(issues: { title: string; body: string }[]): Exec =>
		async () => ({
			exitCode: 0,
			stdout: issues
				.map((i, n) =>
					JSON.stringify({
						number: n + 1,
						state: "open",
						labels: [],
						pr: false,
						...i,
					}),
				)
				.join("\n"),
			stderr: "",
		});

	it("refuses a Portia run on a tracker an earlier run planned, pointing at eval reset", async () => {
		const f = fake([1]);
		const r = await runArm({
			...opts(f.run),
			gh: tracker([
				{ title: "ACME-500: Rocket delivery", body: "Ticket." },
				{
					title: "ACME-501: Manifest",
					body: "Ticket.\n\n```plan\nwave: 1\n```",
				},
			]),
		});
		expect(f.calls).toEqual([]);
		expect(r.refused).toContain("ACME-501 still carry a ```plan block");
		expect(r.refused).toContain("eval reset");
		expect(r.refused).toContain("--epic ACME-500");
		expect(readLedger(root)).toEqual([]);
	});

	it("--stop-if-worse stops after one repeat that scores below the baseline", async () => {
		for (const [n, passRate] of [0.875, 1, 1].entries())
			save(
				root,
				result({ arm: "portia", n: n + 1, passRate, armVersion: "old" }),
			);
		const f = fake([0.25, 1, 1]);
		const r = await runArm(opts(f.run));
		expect(f.calls).toEqual([1]);
		expect(r.stopped).toContain("stopped after one repeat");
		expect(r.stopped).toContain("hidden scenarios passed 25%");
		expect(readLedger(root)).toHaveLength(1);
	});

	it("--stop-if-worse carries on when the first repeat is level", async () => {
		save(
			root,
			result({ arm: "portia", n: 1, passRate: 0.875, armVersion: "old" }),
		);
		const f = fake([0.875, 1, 1]);
		const r = await runArm(opts(f.run));
		expect(f.calls).toEqual([1, 2, 3]);
		expect(r.stopped).toBeUndefined();
	});

	it("stops at the ceiling between repeats", async () => {
		const now = Date.now();
		record(
			root,
			entry({ at: new Date(now - 8 * DAY).toISOString(), tokens: 1e6 }),
		);
		record(
			root,
			entry({
				at: new Date(now).toISOString(),
				arm: "claude-serial",
				tokens: 1.5e6,
			}),
		);
		const f = fake([1, 1, 1]);
		const r = await runArm({ ...opts(f.run), stopIfWorse: false });
		// 1.5M spent and 1M expected: the first fits. It spends 700k, so 2.2M is spent
		// and 850k expected, and the second does not.
		expect(f.calls).toEqual([1]);
		expect(r.refused).toContain("It can run on");
	});
});

describe("eval run, queue and drain", () => {
	let root: string;
	let bin: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "eval-budget-cli-"));
		bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${CLAUDE}"\n`);
		chmodSync(join(bin, "claude"), 0o755);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const cli = async (...args: string[]) => {
		const env: Record<string, string | undefined> = {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
		};
		delete env.EVAL_WEEKLY_TOKENS;
		const p = Bun.spawn(
			[process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
			{ cwd: root, stdout: "pipe", stderr: "pipe", env },
		);
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { out, err, code };
	};
	/** A ledger at the ceiling this week, with claude-serial's past runs on the epic. */
	const atCeiling = () => {
		const now = Date.now();
		record(
			root,
			entry({
				at: new Date(now - 9 * DAY).toISOString(),
				arm: "claude-serial",
				tokens: 800_000,
			}),
		);
		for (let i = 0; i < 4; i++)
			record(
				root,
				entry({ at: new Date(now - i * 1000).toISOString(), tokens: 750_000 }),
			);
	};
	const nextMonday = () =>
		isoDate(new Date(weekStart(new Date()).getTime() + 7 * DAY));
	const files = () =>
		readdirSync(join(root, "results"), { recursive: true }).map(String).sort();

	it("refuses a run at the ceiling and names the date it can run", async () => {
		atCeiling();
		const { code, err } = await cli(
			"run",
			SUITE,
			"--arm",
			"claude-serial",
			"--epic",
			"ACME-500",
		);
		expect(code).toBe(1);
		expect(err).toContain(
			"refused: claude-serial on ACME-500 is expected to cost 0.80M; 3.00M of this week's 3.00M is spent",
		);
		expect(err).toContain(`It can run on ${nextMonday()}.`);
		expect(existsSync(join(root, "results", "v1"))).toBe(false);
	});

	it("reuses a competitor's cached result on a second run and spends nothing", async () => {
		// The first run: a fake stands in for the arm and records its spend.
		const first = await runArm({
			suite: loadSuite(SUITE),
			arm: ARMS["claude-serial"] as NonNullable<(typeof ARMS)["claude-serial"]>,
			epicKey: "ACME-500",
			root,
			repeat: 1,
			tools: TOOLS,
			run: async (o) => {
				const r = result({ n: 1, armVersion: o.tools?.armVersion });
				save(root, r);
				return r;
			},
			log: () => {},
		});
		expect(first.ran).toHaveLength(1);
		atCeiling();
		const ledger = readFileSync(ledgerFile(root), "utf8");
		const before = files();

		const { code, out } = await cli(
			"run",
			SUITE,
			"--arm",
			"claude-serial",
			"--epic",
			"ACME-500",
		);
		expect(code).toBe(0);
		expect(JSON.parse(out.trim().split("\n").at(-1) ?? "")).toMatchObject({
			arm: "claude-serial",
			n: 1,
			reused: true,
			tokens: 0,
		});
		expect(readFileSync(ledgerFile(root), "utf8")).toBe(ledger);
		expect(files()).toEqual(before);

		// --fresh does not reuse it, so at the ceiling it is refused.
		const fresh = await cli(
			"run",
			SUITE,
			"--arm",
			"claude-serial",
			"--epic",
			"ACME-500",
			"--fresh",
		);
		expect(fresh.code).toBe(1);
		expect(fresh.err).toContain("refused:");
	});

	it("queues runs, and drains them one at a time until the ceiling refuses one", async () => {
		save(root, result({ n: 1 }));
		atCeiling();
		await cli("queue", SUITE, "--arm", "claude-serial", "--epic", "ACME-500");
		const listed = await cli(
			"queue",
			SUITE,
			"--arm",
			"claude-parallel",
			"--epic",
			"ACME-500",
			"--repeat",
			"3",
			"--iteration",
			"0",
		);
		expect(listed.out).toContain("1. claude-serial on ACME-500 × 1");
		expect(listed.out).toContain(
			"2. claude-parallel on ACME-500 × 3 (iteration 0): no estimate, waits for next week",
		);

		const drained = await cli("drain");
		expect(drained.code).toBe(0);
		expect(drained.out).toContain('"reused":true');
		expect(drained.err).toContain(`It can run on ${nextMonday()}.`);
		expect(drained.out).toContain("1 run(s) still queued");
		expect(readQueue(root).map((q) => q.arm)).toEqual(["claude-parallel"]);
	});

	it("eval report ends with tokens per week and per iteration", async () => {
		save(root, result({ n: 1 }));
		record(root, entry({ at: "2026-10-27T10:00:00Z", iteration: "1" }));
		const { code, out } = await cli("report", SUITE);
		expect(code).toBe(0);
		expect(out).toContain("## Tokens spent");
		expect(out).toContain("| 2026-10-26 | 750,000 | 1 | 25% |");
		expect(out).toContain("| 1 | 750,000 | 1 | 750,000 |");
		const changelog = await cli("changelog", SUITE, "--iteration", "1");
		expect(changelog.out).toContain("**Tokens:** 750,000 over 1 run(s)");
	});
});
