import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clock, dayLabel, tokens } from "../../../src/view/model/format";
import { memoryFs } from "../../../src/view/model/fs";
import { readHome } from "../../../src/view/model/home";
import { readRun, titleParts } from "../../../src/view/model/run";
import { fixtureFs, frame, HOME, NOW } from "../helpers";

const home = readHome(fixtureFs(), HOME, NOW);
const run = (k: string) => {
	const r = home.runs.find((x) => x.key === k);
	if (!r) throw new Error(k);
	return r;
};

describe("the fixture home", () => {
	it("groups every run", () => {
		expect(home.runs.map((r) => [r.key, r.group, r.glyph])).toEqual([
			["ACME-410", "waiting", "parked"],
			["ACME-500", "session", "running"],
			["ACME-366", "judgement", "failed"],
			["ACME-390", "rest", "quiet"],
			["ACME-352", "rest", "empty"],
			["ACME-377", "delivered", "delivered"],
		]);
		expect(home).toMatchObject({
			inSession: 1,
			needYou: 2,
			runningChildren: 2,
		});
	});
	it("takes each run's plan from the best source on disk", () => {
		expect(run("ACME-500").source).toBe("plan");
		expect(run("ACME-410").source).toBe("ledger");
		expect(run("ACME-366").source).toBe("runlog");
		expect(run("ACME-352").source).toBe("empty");
		expect(run("ACME-366").waves.map((w) => w.label)).toEqual(["unplanned"]);
		expect(run("ACME-410").summary).toBeUndefined();
		expect(run("ACME-500").summary).toBe(
			"Self-serve invoices for team accounts",
		);
	});
	it("counts the broken line and ignores a half-written last line", () => {
		expect(run("ACME-410").skipped).toBe(1);
		expect(run("ACME-377").skipped).toBe(0);
		expect(run("ACME-377").lastEvent).toBe("epic gate ✓ 7 steps");
	});
	it("reads ACME-505 on its second attempt, in its exit gate", () => {
		const c = run("ACME-500").children.find((x) => x.key === "ACME-505");
		expect(c).toMatchObject({
			state: "running",
			phase: "exit gate",
			attempt: 2,
			tokens: 127315,
			tokensCounting: true,
		});
		expect(c?.attempts.map((a) => a.outcome)).toEqual([
			"land failed",
			"running",
		]);
		expect(c?.env).toMatchObject({ port: 3101, up: true });
		expect(c?.approvals.map((a) => a.glob)).toEqual(["src/invoice/render/**"]);
		expect(c?.needs).toEqual([{ key: "ACME-502", state: "landed" }]);
		expect(run("ACME-500").lastEvent).toBe("ACME-505 task gate ✓ 3/3");
	});
	it("marks a child with no row for 45 minutes as quiet, not running", () => {
		const c = run("ACME-390").children.find((x) => x.key === "ACME-394");
		expect(c?.phase).toBe("quiet");
		expect(run("ACME-390").lastEvent).toBe("ACME-394 quiet 3h");
	});
});

describe("fallbacks", () => {
	const rows = (child: string) =>
		`${JSON.stringify({ at: "2026-10-20T10:00:00.000Z", child, attempt: 1, stage: "dispatched", model: { requested: "opus" } })}\n`;
	it("a runlog alone gives unplanned children, none ready", () => {
		const fs = memoryFs({ "/h/runs/ACME-600/runlog.jsonl": rows("ACME-601") });
		const r = readRun(fs, "/h", "ACME-600", NOW);
		expect(r.source).toBe("runlog");
		expect(r.children.map((c) => [c.key, c.state])).toEqual([
			["ACME-601", "running"],
		]);
	});
	it("takes this run's ports from the machine-wide pool", () => {
		const fs = memoryFs({
			"/h/runs/ACME-600/runlog.jsonl": rows("ACME-601"),
			"/h/runs/ports.json": JSON.stringify([
				{ port: 3200, run: "ACME-600", child: "ACME-601", pid: 1 },
				{ port: 3201, run: "ACME-700", child: "ACME-701", pid: 2 },
			]),
		});
		expect(readRun(fs, "/h", "ACME-600", NOW).ports).toEqual([3200]);
	});
	it("an empty directory is not started, never an error", () => {
		const r = readRun(
			memoryFs({ "/h/runs/ACME-601/": "" }),
			"/h",
			"ACME-601",
			NOW,
		);
		expect(r).toMatchObject({
			source: "empty",
			glyph: "empty",
			lastEvent: "not started",
			children: [],
		});
	});
	it("titles a run with no plan snapshot from its epic PR", () => {
		const asked: unknown[] = [];
		const fs = {
			...memoryFs({
				"/h/runs/ACME-600/runlog.jsonl": `${JSON.stringify({ at: "2026-10-20T10:00:00.000Z", child: "ACME-600-EPIC", attempt: 1, stage: "env", status: "up", data: { worktree: "/w/ACME-600", branch: "epic/ACME-600" } })}\n${rows("ACME-601")}`,
				"/h/runs/ACME-600/epic.json": '{"epicPr":2260}',
				"/w/ACME-600/": "",
			}),
			prTitle: (run: string, pr: number, worktrees: string[]) => {
				asked.push([run, pr, worktrees]);
				return "feat(live-sessions): ACME-600 Simplify the studio and make OBS reliable";
			},
		};
		const r = readRun(fs, "/h", "ACME-600", NOW);
		expect(asked).toEqual([["ACME-600", 2260, ["/w/ACME-600"]]]);
		expect(r).toMatchObject({
			source: "runlog",
			summary: "Simplify the studio and make OBS reliable",
			scope: "live-sessions",
		});
	});
	it("asks for no PR title when the plan snapshot has one", () => {
		const fs = fixtureFs({
			[`${HOME}/runs/ACME-500/epic.json`]: '{"epicPr":1}',
		});
		const asked: number[] = [];
		const r = readRun(
			{
				...fs,
				prTitle: (_run, pr) => {
					asked.push(pr);
					return "fix: ACME-500 other";
				},
			},
			HOME,
			"ACME-500",
			NOW,
		);
		expect(asked).toEqual([]);
		expect(r.summary).toBe("Self-serve invoices for team accounts");
	});
	it("reads a conventional title's summary and scope", () => {
		expect(
			titleParts("feat(live-sessions): ACME-944 simplify the studio"),
		).toEqual({
			summary: "simplify the studio",
			scope: "live-sessions",
		});
		expect(titleParts("fix(web)!: ACME-887 harden the job")).toEqual({
			summary: "harden the job",
			scope: "web",
		});
		expect(titleParts("chore: tidy up")).toEqual({
			summary: "tidy up",
			scope: undefined,
		});
		expect(titleParts("Just a title")).toEqual({ summary: "Just a title" });
	});
	it("a bad plan snapshot falls back to the ledger", () => {
		const fs = fixtureFs({
			[`${HOME}/runs/ACME-500/plan.json`]: '{"version": 9}',
		});
		expect(readRun(fs, HOME, "ACME-500", NOW).source).toBe("ledger");
	});
});

describe("formats", () => {
	it("tokens, clocks and day labels", () => {
		expect([
			tokens(999),
			tokens(127315),
			tokens(999_499),
			tokens(999_500),
			tokens(undefined),
		]).toEqual(["999", "127k", "999k", "1.00M", "—"]);
		expect([
			clock(42_000),
			clock(724_000),
			clock(4_320_000),
			clock(183_600_000),
		]).toEqual(["42s", "12m 04s", "1h 12m", "2d 3h"]);
		expect([clock(724_000, true), clock(4_320_000, true)]).toEqual([
			"12:04",
			"1h12",
		]);
		expect(dayLabel("2026-10-20T01:00:00Z", NOW)).toBe("T O D A Y");
		expect(dayLabel("2026-10-19T01:00:00Z", NOW)).toBe("Y E S T E R D A Y");
		expect(dayLabel("2026-10-18T01:00:00Z", NOW)).toBe("O C T   1 8");
	});
});

const line = (o: Record<string, unknown>) =>
	JSON.stringify({
		at: "2026-10-20T10:00:00.000Z",
		child: "ACME-601",
		attempt: 1,
		stage: "dispatched",
		...o,
	});
const LEDGER_600 = [
	"<!-- epic-ledger:start -->",
	"| Wave | Child | State | PR | Requirements | Touches | Design | Model |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
	"| 0 | ACME-601 Spine | landed | #10 | R1 ✓ | matched |  | opus |",
	"| 1 | ACME-602 Waits on a key outside the run | pending |  | R2 ✗ |  |  |  |",
	"<!-- epic-ledger:end -->",
].join("\n");

describe("reading back what Portia wrote", () => {
	it("takes branch names from the env rows, whatever the prefix", () => {
		const fs = memoryFs({
			[`${HOME}/runs/ACME-600/runlog.jsonl`]: `${[
				line({
					child: "ACME-600-EPIC",
					attempt: 0,
					stage: "env",
					status: "up",
					data: { branch: "portia/ACME-600-EPIC", port: 3100 },
				}),
				line({}),
			].join("\n")}\n`,
		});
		const r = readRun(fs, HOME, "ACME-600", NOW);
		expect(r.branch).toBe("portia/ACME-600");
		expect(r.children[0]?.branch).toBe("portia/ACME-601");
		const bare = readRun(
			memoryFs({ [`${HOME}/runs/ACME-600/runlog.jsonl`]: `${line({})}\n` }),
			HOME,
			"ACME-600",
			NOW,
		);
		expect(bare.branch).toBe("");
		expect(bare.children[0]?.branch).toBeUndefined();
	});
	it("keeps a ledger child pending when the ledger says so, until something lands", () => {
		const log = `${line({ stage: "landed", status: "landed", at: "2026-10-20T09:00:00.000Z" })}\n`;
		const files = {
			[`${HOME}/runs/ACME-600/ledger-body.md`]: LEDGER_600,
			[`${HOME}/runs/ACME-600/runlog.jsonl`]: log,
		};
		const written = Date.parse("2026-10-20T09:30:00.000Z");
		const fs = memoryFs(files, {
			[`${HOME}/runs/ACME-600/ledger-body.md`]: written,
		});
		const r = readRun(fs, HOME, "ACME-600", NOW);
		expect(r.source).toBe("ledger");
		expect(r.children.find((c) => c.key === "ACME-602")?.state).toBe("pending");
		const stale = memoryFs(files, {
			[`${HOME}/runs/ACME-600/ledger-body.md`]: written - 3_600_000,
		});
		expect(
			readRun(stale, HOME, "ACME-600", NOW).children.find(
				(c) => c.key === "ACME-602",
			)?.state,
		).toBe("ready");
	});
	it("counts evidence only from an attempt that landed", () => {
		const fs = memoryFs({
			[`${HOME}/runs/ACME-600/runlog.jsonl`]: `${[
				line({}),
				line({
					stage: "result",
					status: "done",
					data: { evidence: { R1: "31 pass" } },
				}),
				line({ stage: "land", status: "failed", data: { reason: "conflict" } }),
				line({ attempt: 2 }),
			].join("\n")}\n`,
		});
		const c = readRun(fs, HOME, "ACME-600", NOW).children[0];
		expect(c?.evidence).toEqual({});
		expect(c?.unlandedEvidence).toEqual({
			attempt: 1,
			evidence: { R1: "31 pass" },
		});
	});
});

describe("a well-formed row with a bad value", () => {
	it("reads a result status no writer uses as failed, and every screen still renders", () => {
		const log = join(HOME, "runs/ACME-366/runlog.jsonl");
		const original = readFileSync(
			join(
				import.meta.dirname,
				"../../fixtures/view/home/runs/ACME-366/runlog.jsonl",
			),
			"utf8",
		);
		const odd = `${JSON.stringify({
			at: "2026-10-20T11:41:00.000Z",
			child: "ACME-369",
			attempt: 1,
			stage: "result",
			status: "weird",
		})}\n`;
		const fs = fixtureFs({ [log]: original + odd });
		const r = readHome(fs, HOME, NOW).runs.find((x) => x.key === "ACME-366");
		const c = r?.children.find((x) => x.key === "ACME-369");
		expect(c?.state).toBe("failed");
		expect(c?.attempts.at(-1)?.outcome).toBe("failed");
		for (const args of [
			[],
			["ACME-366"],
			["ACME-366", "--page", "gates"],
			["--page", "activity"],
			["ACME-366", "ACME-369"],
		])
			expect(() => frame(args, { fs })).not.toThrow();
	});
});
