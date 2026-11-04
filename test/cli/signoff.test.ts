import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, realExec } from "../../src/core/exec";
import { runDir } from "../../src/core/rundir";
import { appendRow, readRows } from "../../src/core/runlog";
import {
	readQuestions,
	recordQuestions,
	unanswered,
} from "../../src/questions/questions";
import { FakeTracker } from "../support/fake-tracker";

const FIXTURE = join(import.meta.dirname, "../fixtures/profile.ts");
const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
};
const restores: (() => void)[] = [];
let base: string;
let repo: string;
let head: string;

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;

beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "portia-signoff-cli-"));
	repo = join(base, "repo");
	for (const f of ["packages/acme-web/package.json", "src/lib/x.ts"]) {
		mkdirSync(join(repo, f, ".."), { recursive: true });
		writeFileSync(join(repo, f), "{}\n");
	}
	await must(realExec, "git", ["init", "-q", "-b", "main", repo]);
	await must(realExec, "git", ["add", "."], { cwd: repo });
	await must(
		realExec,
		"git",
		["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
		{ cwd: repo },
	);
	head = (
		await must(realExec, "git", ["rev-parse", "HEAD"], { cwd: repo })
	).trim();
	process.chdir(repo);
	process.env.PORTIA_PROFILE = FIXTURE;
	process.env.PORTIA_HOME = join(base, "home");
	const tracker = new FakeTracker()
		.add({
			key: "ACME-187",
			summary: "Epic",
			description: fenced("scope: onboarding\nscenario: F1 = Given x, Then y"),
			blockedBy: [],
		})
		.add(
			{
				key: "ACME-201",
				summary: "Spine",
				description: fenced(
					"wave: 0\ntouches: src/lib/**\nevidence: bun test lib\nacceptance: F1 = specs-it/acceptance/a.it.ts\nsize: S",
				),
				blockedBy: [],
			},
			"ACME-187",
		);
	restores.push(useTracker(tracker));
});

afterEach(() => {
	while (restores.length) restores.pop()?.();
	process.chdir(saved.cwd);
	for (const [k, v] of [
		["PORTIA_PROFILE", saved.profile],
		["PORTIA_HOME", saved.home],
	] as const)
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
});

async function portia(...argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		out: (s) => out.push(s),
		err: (s) => err.push(s),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

it("records the plan's approval: who, the repo's commit, the plan's hash and how long they took", async () => {
	const file = join(base, "plan.json");
	writeFileSync(file, '{"parent":{"block":"scope: x"},"children":[]}\n');
	const asked = new Date(Date.now() - 12 * 60_000);
	utimesSync(file, asked, asked);
	const r = await portia("signoff", "plan", "acme-187", "--from", file);
	expect(r.code, r.err).toBe(0);
	const [row] = readRows(runDir("ACME-187")).rows;
	expect(row).toMatchObject({
		child: "ACME-187",
		attempt: 0,
		stage: "approval",
		status: "approved",
		data: { by: "person", commit: head },
	});
	expect(row?.data?.plan).toMatch(/^[0-9a-f]{64}$/);
	expect(row?.data?.waitedMinutes).toBeCloseTo(12, 0);
});

it("records the spine's spec sign-off on the commit its worker finished on", async () => {
	const dir = runDir("ACME-187");
	appendRow(dir, {
		child: "ACME-201",
		attempt: 2,
		stage: "result",
		status: "done",
		data: { head: "abc1234def" },
	});
	const r = await portia(
		"signoff",
		"specs",
		"ACME-187",
		"--by",
		"eval",
		"--note",
		"all four specs match",
	);
	expect(r.code, r.err).toBe(0);
	expect(readRows(dir).rows.at(-1)).toMatchObject({
		child: "ACME-201",
		attempt: 2,
		stage: "signoff",
		status: "approved",
		data: { by: "eval", commit: "abc1234def", note: "all four specs match" },
	});
});

it("a result from before results carried their head signs off the spine worktree's HEAD; a no is recorded too", async () => {
	const dir = runDir("ACME-187");
	writeFileSync(
		join(dir, "env-ACME-201.json"),
		JSON.stringify({ worktree: repo, branch: "portia/ACME-201" }),
	);
	appendRow(dir, {
		child: "ACME-201",
		attempt: 1,
		stage: "result",
		status: "done",
	});
	const r = await portia("signoff", "specs", "ACME-187", "--no");
	expect(r.code, r.err).toBe(0);
	expect(readRows(dir).rows.at(-1)).toMatchObject({
		stage: "signoff",
		status: "rejected",
		data: { by: "person", commit: head },
	});
});

it("refuses a spec sign-off before the spine has a done result, and an unknown signer", async () => {
	const early = await portia("signoff", "specs", "ACME-187");
	expect(early.code).toBe(11);
	expect(early.err).toContain("ACME-201 has no done result yet");
	const who = await portia("signoff", "specs", "ACME-187", "--by", "bot");
	expect(who.code).toBe(11);
	expect(who.err).toContain("usage: portia signoff");
});

it("records the reviewer's no to the spine's specs as the reviewer's, and refuses a reviewer yes", async () => {
	const dir = runDir("ACME-187");
	appendRow(dir, {
		child: "ACME-201",
		attempt: 1,
		stage: "result",
		status: "done",
		data: { head: "abc1234def" },
	});
	const no = await portia(
		"signoff",
		"specs",
		"ACME-187",
		"--by",
		"reviewer",
		"--no",
		"--note",
		"Review finding: F1 asserts a brittle path",
	);
	expect(no.code, no.err).toBe(0);
	expect(readRows(dir).rows.at(-1)).toMatchObject({
		stage: "signoff",
		status: "rejected",
		data: { by: "reviewer", commit: "abc1234def" },
	});
	const yes = await portia("signoff", "specs", "ACME-187", "--by", "reviewer");
	expect(yes.code).toBe(11);
	expect(yes.err).toContain("usage: portia signoff");
	const plan = await portia(
		"signoff",
		"plan",
		"ACME-187",
		"--from",
		"x.md",
		"--by",
		"reviewer",
		"--no",
	);
	expect(plan.code).toBe(11);
	expect(plan.err).toContain("usage: portia signoff");
});

describe("eval-answer", () => {
	const script = (body: unknown) => {
		const f = join(base, "person.json");
		writeFileSync(f, JSON.stringify(body));
		process.env.PORTIA_EVAL_ANSWERS = f;
	};
	afterEach(() => {
		delete process.env.PORTIA_EVAL_ANSWERS;
	});

	it("without a script, says to ask the person (exit 10) and records nothing", async () => {
		const r = await portia("eval-answer", "go", "ACME-187");
		expect(r.code).toBe(10);
		expect(readRows(runDir("ACME-187")).rows).toEqual([]);
	});

	it("a section the script leaves out is asked as usual", async () => {
		script({ plan: { approve: true } });
		const r = await portia(
			"eval-answer",
			"parked",
			"ACME-201",
			"--parent",
			"ACME-187",
			"--question",
			"May I?",
		);
		expect(r.code).toBe(10);
	});

	it("approves the plan and the specs as the scripted person, and a scripted no stops the run", async () => {
		script({ plan: { approve: true }, signoff: { approve: false } });
		const file = join(base, "plan.json");
		writeFileSync(file, "{}\n");
		expect((await portia("eval-answer", "go", "ACME-187")).code).toBe(0);
		const p = await portia("eval-answer", "plan", "ACME-187", "--from", file);
		expect(p.code, p.err).toBe(0);
		const dir = runDir("ACME-187");
		appendRow(dir, {
			child: "ACME-201",
			attempt: 1,
			stage: "result",
			status: "done",
			data: { head: "abc1234" },
		});
		const s = await portia("eval-answer", "specs", "ACME-187");
		expect(s.code).toBe(11);
		expect(
			readRows(dir)
				.rows.filter((r) => r.stage === "approval" || r.stage === "signoff")
				.map((r) => [r.stage, r.status, r.data?.by, r.data?.commit]),
		).toEqual([
			["approval", "approved", "eval", head],
			["signoff", "rejected", "eval", "abc1234"],
		]);
	});

	it("answers a parked question by pattern and records who answered", async () => {
		script({
			parked: {
				default: "Yes, carry on.",
				byPattern: [{ match: "secret", answer: "No." }],
			},
		});
		const r = await portia(
			"eval-answer",
			"parked",
			"ACME-201",
			"--parent",
			"ACME-187",
			"--question",
			"Should I commit the SECRET?",
		);
		expect(r.code, r.err).toBe(0);
		expect(JSON.parse(r.out)).toEqual({ answer: "No." });
		expect(readRows(runDir("ACME-187")).rows.at(-1)).toMatchObject({
			child: "ACME-201",
			stage: "decision",
			status: "answer",
			data: { kind: "parked", by: "eval", answer: "No." },
		});
	});

	it("answers every open question recorded for the run", async () => {
		script({ parked: { default: "Yes, carry on.", byPattern: [] } });
		const dir = runDir("ACME-187");
		recordQuestions(dir, [
			{ id: "ACME-187/open-1", kind: "open", question: "Behind a flag?" },
			{
				id: "ACME-201/detail",
				child: "ACME-201",
				kind: "detail",
				question: "What must it do?",
				answer: "Already answered.",
			},
		]);
		const r = await portia("eval-answer", "questions", "ACME-187");
		expect(r.code, r.err).toBe(0);
		expect(JSON.parse(r.out)).toEqual({ "ACME-187/open-1": "Yes, carry on." });
		expect(unanswered(readQuestions(dir) ?? [])).toEqual([]);
		expect(
			readRows(dir).rows.filter((r) => r.stage === "decision"),
		).toHaveLength(1);
	});

	it("a bad script is a problem, never ignored", async () => {
		script({ signoff: { approve: "yes" } });
		const r = await portia("eval-answer", "go", "ACME-187");
		expect(r.code).toBe(11);
		expect(r.err).toContain("signoff.approve");
	});
});
