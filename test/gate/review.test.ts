import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import type { ExecResult } from "../../src/core/exec";
import { writePlanSnapshot } from "../../src/core/plan-snapshot";
import { appendRow, readRows } from "../../src/core/runlog";
import {
	parseFindings,
	reviewChild,
	reviewOutcome,
	verdictOf,
} from "../../src/gate/review";
import { fakeExec } from "../helpers/fake-exec";
import { child, parent, spine } from "../helpers/plan";

const spec = {
	cmd: "reviewer --json",
	timeoutMs: 20 * 60_000,
	onFindings: "fail" as const,
};
const env = {
	worktree: "/wt/ACME-2",
	branch: "portia/ACME-2",
	db: "d",
	port: 3101,
	envFile: "/nonexistent/.env.portia",
};
const result = (o: Partial<ExecResult>): ExecResult => ({
	code: 0,
	stdout: "",
	stderr: "",
	...o,
});

describe("parseFindings", () => {
	it("reads the last JSON line with a findings array, after any other output", () => {
		const out = [
			"reviewing 3 files…",
			'{"progress": 1}',
			'{"findings":[{"severity":"high","message":"null deref","file":"src/a.ts","line":12},"plain text finding"]}',
			"done",
		].join("\n");
		expect(parseFindings(out)).toEqual([
			{
				severity: "high",
				message: "null deref",
				file: "src/a.ts",
				line: 12,
			},
			{ message: "plain text finding" },
		]);
	});
	it("reads a whole pretty-printed JSON object", () => {
		const out = JSON.stringify(
			{ findings: [{ level: "P1", title: "t", path: "b.ts" }] },
			null,
			2,
		);
		expect(parseFindings(out)).toEqual([
			{ severity: "P1", message: "t", file: "b.ts" },
		]);
	});
	it("skips findings with no message and ignores a bad line number", () => {
		expect(
			parseFindings(
				'{"findings":[{"severity":"low"},{"message":"m","line":"x"},42,null]}',
			),
		).toEqual([{ message: "m" }]);
	});
	it("is undefined when nothing parses as a verdict", () => {
		expect(parseFindings("")).toBeUndefined();
		expect(parseFindings("{not json}\n[1,2]")).toBeUndefined();
		expect(parseFindings('{"verdict":"clean"}')).toBeUndefined();
	});
});

describe("verdictOf", () => {
	it("lets the exit code decide: 0 clean, 1 findings, anything else an error", () => {
		const listed = '{"findings":["advisory"]}';
		expect(verdictOf(result({ code: 0, stdout: listed }))).toMatchObject({
			status: "clean",
			findings: [{ message: "advisory" }],
		});
		expect(verdictOf(result({ code: 1, stdout: listed }))).toMatchObject({
			status: "findings",
			exit: 1,
		});
		expect(verdictOf(result({ code: 127 })).status).toBe("error");
		expect(verdictOf(result({ code: 124, timedOut: true }))).toMatchObject({
			status: "error",
			timedOut: true,
		});
	});
});

describe("reviewOutcome", () => {
	const head = "abcdef0123456789";
	it("lets a clean review land", () => {
		expect(
			reviewOutcome(verdictOf(result({ code: 0 })), spec, head),
		).toBeUndefined();
	});
	it("fails the land with each finding in the reason, so a retry's brief carries them", () => {
		const v = verdictOf(
			result({
				code: 1,
				stdout:
					'{"findings":[{"severity":"high","message":"leaks a handle","file":"src/a.ts","line":3},{"message":"no test"}]}',
			}),
		);
		expect(reviewOutcome(v, spec, head)).toEqual({
			status: "failed",
			review: "findings",
			reason:
				"the child review found 2 findings at abcdef0\n- [high] src/a.ts:3 leaks a handle\n- no test",
		});
	});
	it("parks on findings when the profile says so", () => {
		const v = verdictOf(result({ code: 1, stdout: "looks risky" }));
		expect(reviewOutcome(v, { ...spec, onFindings: "park" }, head)).toEqual({
			status: "parked",
			review: "findings",
			reason: "the child review found findings at abcdef0\nlooks risky",
		});
	});
	it("parks on an error or a timeout, which a retried worker cannot fix", () => {
		expect(
			reviewOutcome(
				verdictOf(result({ code: 127, stderr: "reviewer: not found" })),
				spec,
				head,
			),
		).toEqual({
			status: "parked",
			review: "error",
			reason:
				"the child review could not run (exit 127) at abcdef0\nreviewer: not found",
		});
		expect(
			reviewOutcome(
				verdictOf(result({ code: 124, timedOut: true })),
				spec,
				head,
			)?.reason,
		).toMatch(/^the child review timed out after 1200000ms at abcdef0/);
	});
});

describe("reviewOutcome's reason", () => {
	const head = "abcdef0123456789";
	it("stays near 2,000 characters however many findings there are, and says how many it left out", () => {
		const findings = Array.from({ length: 80 }, (_, i) => ({
			severity: "high",
			message: `${"x".repeat(480)} ${i}`,
			file: "src/a.ts",
		}));
		const v = verdictOf(
			result({ code: 1, stdout: JSON.stringify({ findings }) }),
		);
		const reason = reviewOutcome(v, spec, head)?.reason ?? "";
		expect(reason.length).toBeLessThan(2_200);
		expect(reason).toMatch(/^the child review found 50 findings at abcdef0\n/);
		expect(reason).toMatch(/\n\(\+4\d more\)$/);
	});
	it("caps the output tail when no findings parsed and on an error", () => {
		const long = Array.from({ length: 30 }, () => "y".repeat(400)).join("\n");
		for (const code of [1, 2]) {
			const r = reviewOutcome(
				verdictOf(result({ code, stdout: long })),
				spec,
				head,
			);
			expect(r?.reason.length).toBeLessThan(2_200);
		}
	});
});

describe("reviewChild", () => {
	it("runs the command in the worktree on base..head with its env and timeout, and logs the verdict", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-review-"));
		const { exec, calls } = fakeExec((c) =>
			c.cmd === "git"
				? { stdout: "diff --git a/x b/x\n" }
				: { code: 1, stdout: '{"findings":[{"message":"m"}]}' },
		);
		const profile = { ...testProfile(), gateEnv: { KEY: "v" } };
		const v = await reviewChild({
			exec,
			profile,
			spec: { ...spec, timeoutMs: 5_000 },
			dir,
			env,
			child: "ACME-2",
			parent: "ACME-0",
			base: "b".repeat(40),
			head: "h".repeat(40),
		});
		expect(v.status).toBe("findings");
		expect(calls[0]).toMatchObject({
			cmd: "git",
			args: ["diff", `${"b".repeat(40)}..${"h".repeat(40)}`],
			cwd: env.worktree,
		});
		const diff = join(dir, "review-ACME-2.diff");
		expect(readFileSync(diff, "utf8")).toBe("diff --git a/x b/x\n");
		expect(calls[1]).toMatchObject({
			cmd: "sh",
			args: ["-c", "reviewer --json"],
			cwd: env.worktree,
			timeoutMs: 5_000,
			env: {
				KEY: "v",
				PORTIA_BASE_SHA: "b".repeat(40),
				PORTIA_HEAD_SHA: "h".repeat(40),
				PORTIA_DIFF: diff,
				PORTIA_CHILD: "ACME-2",
				PORTIA_PARENT: "ACME-0",
				PORTIA_WORKTREE: env.worktree,
			},
		});
		expect(readRows(dir).rows.at(-1)).toMatchObject({
			child: "ACME-2",
			stage: "review",
			status: "findings",
			data: {
				base: "b".repeat(40),
				head: "h".repeat(40),
				exit: 1,
				findings: [{ message: "m" }],
			},
		});
	});
	it("hands the child's accepted ripples to the review command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-review-"));
		appendRow(dir, {
			child: "ACME-2",
			attempt: 1,
			stage: "result",
			status: "done",
			ripples: [{ file: "test/a.test.ts", kind: "test" }],
		});
		const { exec, calls } = fakeExec((c) =>
			c.cmd === "git" ? { stdout: "" } : { code: 0, stdout: "" },
		);
		await reviewChild({
			exec,
			profile: testProfile(),
			spec,
			dir,
			env,
			child: "ACME-2",
			parent: "ACME-0",
			base: "b",
			head: "h",
		});
		expect(calls[1]).toMatchObject({
			env: { PORTIA_RIPPLES: "test test/a.test.ts" },
		});
	});
	it("hands the review the plan's specs and block, and nothing the worker wrote", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-review-"));
		writePlanSnapshot(
			dir,
			parent([spine({ acceptance: { F1: "e2e/a.e2e.ts" } }), child("ACME-2")]),
		);
		appendRow(dir, {
			child: "ACME-2",
			attempt: 1,
			stage: "result",
			status: "done",
			data: { message: "WORKER-SAYS", notes: "WORKER-NOTES", evidence: "E" },
		});
		const { exec, calls } = fakeExec((c) =>
			c.cmd === "git" ? { stdout: "" } : { code: 0, stdout: "" },
		);
		await reviewChild({
			exec,
			profile: testProfile(),
			spec,
			dir,
			env,
			child: "ACME-2",
			parent: "ACME-0",
			base: "b",
			head: "h",
		});
		const sent = calls[1]?.env ?? {};
		expect(sent.PORTIA_SPECS).toBe("F1 e2e/a.e2e.ts");
		const block = readFileSync(sent.PORTIA_PLAN as string, "utf8");
		expect(block).toContain('"ACME-2"');
		expect(JSON.stringify(sent) + block).not.toMatch(/WORKER-/);
	});
});
