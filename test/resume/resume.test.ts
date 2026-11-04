import { recordParkAnswer } from "../../src/core/park-answer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recordLandFailure } from "../../src/cli/commands/land";
import { resumeExit } from "../../src/cli/commands/resume";
import { testProfile } from "../../src/core/config";
import { appendRow, readRows } from "../../src/core/runlog";
import {
	answerQuestions,
	recordQuestions,
} from "../../src/questions/questions";
import { resume } from "../../src/resume/resume";
import { fakeExec } from "../helpers/fake-exec";
import { child, parent, spine } from "../helpers/plan";
import { FakeTracker } from "../support/fake-tracker";

const needOn1 = {
	needs: [{ key: "ACME-1", reason: "r" }],
	blockedBy: ["ACME-1"],
};
const plan = parent([
	spine(),
	child("ACME-2", needOn1),
	child("ACME-3", needOn1),
	child("ACME-4", needOn1),
]);

const setup = (
	merged: {
		headRefName: string;
		number: number;
		mergeCommit: { oid: string };
	}[],
	worktrees: string[],
) => {
	const dir = mkdtempSync(join(tmpdir(), "portia-resume-"));
	const { exec } = fakeExec((c) => {
		if (c.cmd === "gh") return { stdout: JSON.stringify(merged) };
		if (c.cmd === "git" && c.args[0] === "worktree")
			return {
				stdout: worktrees
					.map((b) => `worktree /wt/${b}\nbranch refs/heads/portia/${b}\n`)
					.join("\n"),
			};
		return undefined;
	});
	return { dir, ctx: { exec, profile: testProfile(), repoRoot: "/repo", dir } };
};

it("records a landing GitHub has but the log lost, and never lands it twice (Review focus 5)", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		[],
	);
	appendRow(s.dir, { child: "ACME-1", attempt: 1, stage: "dispatched" });
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "result",
		status: "done",
	});
	const r = await resume(plan, s.ctx);
	expect(r.actions).toContainEqual({
		child: "ACME-1",
		action: "record-landed",
		detail: "PR #41 merged into portia/ACME-0",
	});
	expect(
		r.actions.some((a) => a.child === "ACME-1" && a.action === "land"),
	).toBe(false);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		child: "ACME-1",
		stage: "landed",
		data: { pr: 41, sha: "abc", source: "resume" },
	});
	const again = await resume(plan, s.ctx);
	expect(again.actions.some((a) => a.child === "ACME-1")).toBe(false);
});

it("redispatches a worker with no result, and reports parked, failed and done children", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		["ACME-2"],
	);
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		data: { pr: 41 },
	});
	appendRow(s.dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
	appendRow(s.dir, {
		child: "ACME-3",
		attempt: 1,
		stage: "result",
		status: "parked",
	});
	appendRow(s.dir, {
		child: "ACME-4",
		attempt: 1,
		stage: "result",
		status: "done",
	});
	const r = await resume(plan, s.ctx);
	expect(r.actions).toEqual([
		{
			child: "ACME-2",
			action: "redispatch",
			detail: "no result for attempt 1; a fresh worker resumes in its worktree",
		},
		{
			child: "ACME-3",
			action: "await-answer",
			detail: "parked; waiting on a person",
		},
		{ child: "ACME-4", action: "land", detail: "done but not landed" },
	]);
});

it("reports a log landing that GitHub does not have as a problem", async () => {
	const s = setup([], []);
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		data: { pr: 41 },
	});
	expect((await resume(plan, s.ctx)).problems).toEqual([
		"ACME-1: the run log says landed, but GitHub has no merged PR into portia/ACME-0",
	]);
});

it("takes a landing logged from a PR that built several children as matched by that PR", async () => {
	const s = setup(
		[{ headRefName: "feat/several", number: 57, mergeCommit: { oid: "def" } }],
		[],
	);
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		data: { pr: 57 },
	});
	expect((await resume(plan, s.ctx)).problems).toEqual([]);
});

it("retries the landed tracker transition for a recovered landing, and writes the row once", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		[],
	);
	const tracker = new FakeTracker().add({
		key: "ACME-1",
		summary: "x",
		description: "",
		blockedBy: [],
	});
	const r = await resume(plan, {
		...s.ctx,
		tracker,
		landedTransition: "Review/QA",
	});
	expect(tracker.writes).toEqual([
		{ kind: "transition", key: "ACME-1", state: "Review/QA" },
	]);
	expect(r.actions).toContainEqual({
		child: "ACME-1",
		action: "record-landed",
		detail: "PR #41 merged into portia/ACME-0",
	});
	const landed = readRows(s.dir).rows.filter((x) => x.stage === "landed");
	expect(landed).toHaveLength(1);
	expect(landed[0]?.data).not.toHaveProperty("jiraError");
});

it("records a tracker failure on the recovered landing row, and still writes it once", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		[],
	);
	const tracker = new (class extends FakeTracker {
		async transition(): Promise<void> {
			throw new Error("jira down");
		}
	})();
	const r = await resume(plan, {
		...s.ctx,
		tracker,
		landedTransition: "Review/QA",
	});
	expect(r.problems).toEqual([]);
	const landed = readRows(s.dir).rows.filter((x) => x.stage === "landed");
	expect(landed).toHaveLength(1);
	expect(landed[0]?.data).toMatchObject({ pr: 41, source: "resume" });
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		child: "ACME-1",
		stage: "tracker",
		status: "failed",
		data: { jiraError: "jira down" },
	});
});

it("exits 11 on a problem, 0 while a child is ready, and 10 when all landed or pending", () => {
	const states = (v: string) => new Map([["ACME-1", v as "ready"]]);
	expect(resumeExit({ actions: [], problems: ["x"] }, states("landed"))).toBe(
		11,
	);
	expect(resumeExit({ actions: [], problems: [] }, states("ready"))).toBe(0);
	expect(resumeExit({ actions: [], problems: [] }, states("pending"))).toBe(10);
});

it("a land that parked or failed after a done result is not listed as land again", async () => {
	const s = setup([], []);
	for (const k of ["ACME-2", "ACME-3"]) {
		appendRow(s.dir, { child: k, attempt: 1, stage: "dispatched" });
		appendRow(s.dir, { child: k, attempt: 1, stage: "result", status: "done" });
	}
	recordLandFailure(s.dir, "ACME-2", {
		status: "parked",
		reason: "rebasing ACME-2 onto portia/ACME-0 conflicts",
	});
	recordLandFailure(s.dir, "ACME-3", { status: "failed", reason: "CI failed" });
	const r = await resume(plan, s.ctx);
	const of = (k: string) =>
		r.actions.filter((a) => a.child === k).map((a) => a.action);
	expect(of("ACME-2")).toEqual(["await-answer"]);
	expect(of("ACME-3")).toEqual(["decide-failure"]);
	expect(
		readRows(s.dir).rows.find(
			(x) => x.child === "ACME-2" && x.stage === "land",
		),
	).toMatchObject({
		status: "parked",
		data: { reason: "rebasing ACME-2 onto portia/ACME-0 conflicts" },
	});
});

it("waits on a running child whose detached worker is alive, and redispatches the rest", async () => {
	const s = setup([], ["ACME-2"]);
	for (const k of ["ACME-2", "ACME-3"])
		appendRow(s.dir, { child: k, attempt: 1, stage: "dispatched" });
	const r = await resume(plan, {
		...s.ctx,
		alive: { "ACME-2": "pid 7 is working" },
	});
	expect(r.actions).toEqual([
		{
			child: "ACME-2",
			action: "await-worker",
			detail: "attempt 1 runs detached: pid 7 is working",
		},
		{
			child: "ACME-3",
			action: "redispatch",
			detail:
				"no result for attempt 1 and no worktree; run portia env up first",
		},
	]);
});

it("with askOnce, reports answering the questions ahead of any redispatch", async () => {
	const s = setup([], ["ACME-1"]);
	appendRow(s.dir, { child: "ACME-1", attempt: 1, stage: "dispatched" });
	const ctx = { ...s.ctx, profile: { ...s.ctx.profile, askOnce: true } };
	const first = (await resume(plan, ctx)).actions;
	expect(first.map((a) => a.action)).toEqual([
		"answer-questions",
		"redispatch",
	]);
	expect(first[0]).toMatchObject({ child: "ACME-0" });
	recordQuestions(s.dir, [{ id: "A", kind: "open", question: "A?" }]);
	answerQuestions(s.dir, { A: "yes" });
	expect((await resume(plan, ctx)).actions.map((a) => a.action)).toEqual([
		"redispatch",
	]);
	expect((await resume(plan, s.ctx)).actions.map((a) => a.action)).toEqual([
		"redispatch",
	]);
});

const doneChild1 = (dir: string) => {
	appendRow(dir, { child: "ACME-1", attempt: 1, stage: "dispatched" });
	appendRow(dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "result",
		status: "done",
	});
};

it("routes a land CI or GitHub failed back to land, and any other failed land to decide failure", async () => {
	const s = setup([], []);
	doneChild1(s.dir);
	recordLandFailure(s.dir, "ACME-1", {
		status: "failed",
		reason: "no CI checks appeared on PR #41 within 300000ms",
		infra: true,
	});
	expect((await resume(plan, s.ctx)).actions).toContainEqual({
		child: "ACME-1",
		action: "land",
		detail: "CI or GitHub failed its last landing, not the child",
	});
	recordLandFailure(s.dir, "ACME-1", {
		status: "failed",
		reason: "CI failed on PR #41: unit",
	});
	expect((await resume(plan, s.ctx)).actions).toContainEqual(
		expect.objectContaining({ child: "ACME-1", action: "decide-failure" }),
	);
});

it("waits on a land that is still running rather than starting a second one", async () => {
	const s = setup([], []);
	doneChild1(s.dir);
	writeFileSync(join(s.dir, "land-ACME-1.lock"), String(process.ppid));
	const r = await resume(plan, s.ctx);
	expect(r.actions).toContainEqual({
		child: "ACME-1",
		action: "await-land",
		detail: `portia land is still running for it (pid ${process.ppid})`,
	});
	expect(r.actions.some((a) => a.action === "land")).toBe(false);
});

it("retries a landed transition a land never finished, once", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		[],
	);
	doneChild1(s.dir);
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		status: "landed",
		data: { pr: 41, sha: "abc", tracker: "pending" },
	});
	const tracker = new FakeTracker().add({
		key: "ACME-1",
		summary: "x",
		description: "",
		blockedBy: [],
	});
	const ctx = { ...s.ctx, tracker, landedTransition: "Review/QA" };
	await resume(plan, ctx);
	await resume(plan, ctx);
	expect(tracker.writes).toEqual([
		{ kind: "transition", key: "ACME-1", state: "Review/QA" },
	]);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		child: "ACME-1",
		stage: "tracker",
		status: "transitioned",
	});
});

it("leaves a merge a running land has not recorded yet to that land", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		[],
	);
	doneChild1(s.dir);
	writeFileSync(join(s.dir, "land-ACME-1.lock"), String(process.ppid));
	const r = await resume(plan, s.ctx);
	expect(readRows(s.dir).rows.some((x) => x.stage === "landed")).toBe(false);
	expect(r.actions).toContainEqual(
		expect.objectContaining({ child: "ACME-1", action: "await-land" }),
	);
});

it("tries a failed landed transition again on the next resume, until it succeeds", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		[],
	);
	doneChild1(s.dir);
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		status: "landed",
		data: { pr: 41, sha: "abc", tracker: "pending" },
	});
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "tracker",
		status: "failed",
		data: {
			state: "Review/QA",
			jiraError: "the tracker did not answer within 60000ms",
		},
	});
	const calls: string[] = [];
	const tracker = {
		transition: async (key: string) => {
			calls.push(key);
		},
	};
	const ctx = { ...s.ctx, tracker, landedTransition: "Review/QA" };
	await resume(plan, ctx);
	await resume(plan, ctx);
	expect(calls).toEqual(["ACME-1"]);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		child: "ACME-1",
		stage: "tracker",
		status: "transitioned",
	});
});

it("leaves a pending transition to a land that finished it while resume was busy", async () => {
	const s = setup([], []);
	for (const child of ["ACME-1", "ACME-2"])
		appendRow(s.dir, {
			child,
			attempt: 1,
			stage: "landed",
			status: "landed",
			data: { pr: 41, sha: "abc", tracker: "pending" },
		});
	const calls: string[] = [];
	const tracker = {
		transition: async (key: string) => {
			calls.push(key);
			// Meanwhile ACME-2's own land moves its ticket and logs it.
			if (key === "ACME-1")
				appendRow(s.dir, {
					child: "ACME-2",
					attempt: 1,
					stage: "tracker",
					status: "transitioned",
					data: { state: "Review/QA" },
				});
		},
	};
	await resume(plan, { ...s.ctx, tracker, landedTransition: "Review/QA" });
	expect(calls).toEqual(["ACME-1"]);
	expect(
		readRows(s.dir).rows.filter(
			(r) => r.child === "ACME-2" && r.stage === "tracker",
		),
	).toHaveLength(1);
});

it("lists the wave gate once a wave has landed and the profile has one", async () => {
	const s = setup(
		[{ headRefName: "portia/ACME-1", number: 41, mergeCommit: { oid: "abc" } }],
		[],
	);
	appendRow(s.dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		status: "landed",
	});
	const waves = parent([
		spine(),
		child("ACME-2"),
		child("ACME-3", { wave: 2 }),
	]);
	const gated = {
		...s.ctx,
		profile: { ...testProfile(), waveGate: { steps: ["unit"] } },
	} as typeof s.ctx;
	expect((await resume(waves, gated)).actions).toEqual([
		{
			child: "ACME-0",
			action: "wave-gate",
			detail: "wave 0 has landed; its wave gate runs before the next wave",
		},
	]);
	expect((await resume(waves, s.ctx)).actions).toEqual([]);
	appendRow(s.dir, {
		child: "ACME-0",
		attempt: 0,
		stage: "wave-gate",
		status: "pass",
		data: { wave: 0, tip: "t", steps: [] },
	});
	expect((await resume(waves, gated)).actions).toEqual([]);
});

it("checks a direct landing in git, not on GitHub: its commit on the integration branch is no problem", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-resume-"));
	const onBranch = new Set(["d1"]);
	const calls: string[][] = [];
	const { exec } = fakeExec((c) => {
		if (c.cmd === "gh") return { stdout: "[]" };
		if (c.cmd === "git") calls.push(c.args);
		if (c.cmd === "git" && c.args[0] === "merge-base")
			return { code: onBranch.has(c.args[2] ?? "") ? 0 : 1 };
		return undefined;
	});
	const ctx = { exec, profile: testProfile(), repoRoot: "/repo", dir };
	appendRow(dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		data: { sha: "d1", gated: "g1", onto: "t0", direct: true },
	});
	expect((await resume(plan, ctx)).problems).toEqual([]);
	expect(calls.find((a) => a[0] === "merge-base")?.slice(0, 4)).toEqual([
		"merge-base",
		"--is-ancestor",
		"d1",
		"origin/portia/ACME-0",
	]);
	appendRow(dir, {
		child: "ACME-2",
		attempt: 1,
		stage: "landed",
		data: { sha: "lost", direct: true },
	});
	expect((await resume(plan, ctx)).problems).toEqual([
		"ACME-2: the run log says landed directly as lost, but that commit is not on portia/ACME-0",
	]);
	// Not known locally: fetched once before it counts as missing.
	expect(calls.some((a) => a[0] === "fetch")).toBe(true);
});

it("a parked child whose answer is recorded says the next drive redispatches it", async () => {
	const s = setup([], []);
	appendRow(s.dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
	appendRow(s.dir, {
		child: "ACME-2",
		attempt: 1,
		stage: "result",
		status: "parked",
		data: { message: "Which one?" },
	});
	recordParkAnswer(s.dir, "ACME-2", "the first");
	const r = await resume(plan, s.ctx);
	const a = r.actions.find((x) => x.child === "ACME-2");
	expect(a?.detail).toMatch(/answer is recorded.*next drive redispatches/);
	expect(a?.detail).not.toMatch(/waiting on a person/);
});
