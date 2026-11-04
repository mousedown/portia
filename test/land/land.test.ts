import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	afterLand,
	capRelands,
	landGateInputs,
	landGateView,
	MAX_RELANDS,
	recordLandFailure,
} from "../../src/cli/commands/land";
import {
	type Profile,
	ProfileSchema,
	testProfile,
} from "../../src/core/config";
import { type ExecResult, must, realExec } from "../../src/core/exec";
import { PortiaProblem } from "../../src/core/exit";
import { appendRow, previousAttempt, readRows } from "../../src/core/runlog";
import { withLock } from "../../src/gate/lock";
import type { GateReport } from "../../src/gate/run";
import {
	bucketOf,
	initIntegration,
	integrationWorktree,
	land,
	landRunning,
	MAX_REGATES,
	prTitle,
	rollupChecks,
	syncMain,
} from "../../src/land/integration-and-land";
import acme from "../fixtures/profile";
import { hybridExec, sandbox } from "../helpers/git-sandbox";
import { child, parent, spine } from "../helpers/plan";
import { FakeTracker } from "../support/fake-tracker";

const realGit = (cwd: string, ...args: string[]) =>
	must(realExec, "git", args, { cwd });
const plan = parent([
	spine(),
	child("ACME-2", { summary: "Set-up rules" }),
	child("ACME-3"),
]);
const passGate = async (): Promise<GateReport> => ({
	kind: "exit" as const,
	ok: true,
	steps: [],
});
const child2 = plan.children[1] as (typeof plan.children)[number];
/** The CI poll: one `gh pr view` for the PR's head and its check rollup. */
const isPoll = (args: string[]) =>
	args[1] === "view" && args.includes("headRefOid,statusCheckRollup");
const lastLanded = (dir: string) =>
	readRows(dir)
		.rows.filter((r) => r.stage === "landed")
		.at(-1);
const gh = (args: string[]): Partial<ExecResult> => {
	if (args[1] === "list") return { stdout: "[]" };
	if (args[1] === "create")
		return { stdout: "https://github.com/o/r/pull/42\n" };
	if (args[1] === "checks")
		return { stdout: JSON.stringify([{ name: "unit", bucket: "pass" }]) };
	return {};
};

async function setup(
	gate: (
		key?: string,
		onto?: string,
		landed?: ReadonlySet<string>,
	) => Promise<GateReport> = passGate,
	extra: {
		gh?: typeof gh;
		tracker?: FakeTracker;
	} = {},
) {
	const s = await sandbox();
	const dir = mkdtempSync(join(s.root, "run-"));
	const profile = {
		...testProfile(),
		repo: "acme-web",
		worktreesDir: join(s.root, "wt"),
	};
	const { exec, ghCalls } = hybridExec(extra.gh ?? gh);
	const tracker =
		extra.tracker ??
		new FakeTracker().add({
			key: "ACME-2",
			summary: "Set-up rules",
			description: "",
			blockedBy: [],
		});
	const ctx = {
		exec,
		profile,
		repoRoot: s.repo,
		dir,
		plan,
		tracker,
		gate,
		lockOpts: { timeoutMs: 50, pollMs: 10 },
		checksPollMs: 5,
		checksWaitMs: 100,
	};
	await initIntegration(ctx);
	const wt = join(profile.worktreesDir, profile.repo, "ACME-2");
	await s.g(
		s.repo,
		"worktree",
		"add",
		"-B",
		"portia/ACME-2",
		wt,
		"origin/portia/ACME-0",
	);
	writeFileSync(
		join(dir, "env-ACME-2.json"),
		JSON.stringify({
			worktree: wt,
			branch: "portia/ACME-2",
			db: "d",
			port: 1,
			envFile: "/x",
		}),
	);
	return { ...s, dir, ctx, wt, ghCalls };
}

it("creates the integration branch from main and a draft epic PR", async () => {
	const s = await setup();
	expect(await s.g(s.repo, "ls-remote", "origin", "portia/ACME-0")).toContain(
		"refs/heads/portia/ACME-0",
	);
	expect(s.ghCalls.find((a) => a[1] === "create")).toEqual(
		expect.arrayContaining([
			"--draft",
			"--base",
			"main",
			"--head",
			"portia/ACME-0",
		]),
	);
	expect(integrationWorktree(s.ctx.profile, "ACME-0")).toBe(
		join(s.ctx.profile.worktreesDir, "acme-web", "ACME-0"),
	);
});

it("opens the integration branch one empty commit ahead of main, since GitHub refuses a PR with no commits", async () => {
	const s = await setup();
	expect(
		(
			await s.g(
				s.repo,
				"rev-list",
				"--count",
				"origin/main..origin/portia/ACME-0",
			)
		).trim(),
	).toBe("1");
	expect(
		await s.g(s.repo, "diff", "--stat", "origin/main", "origin/portia/ACME-0"),
	).toBe("");
});

it("lands a child: rebase, gate, push, PR into the integration branch, pinned squash merge", async () => {
	const s = await setup();
	writeFileSync(join(s.wt, "b.txt"), "child\n");
	await s.g(s.wt, "add", ".");
	await s.g(s.wt, "commit", "-m", "child work");
	const out = await land("ACME-2", s.ctx);
	expect(out.status).toBe("landed");
	expect(s.ctx.tracker.writes).toEqual([
		{
			kind: "transition",
			key: "ACME-2",
			state: s.ctx.profile.transitions.landed,
		},
	]);
	const sha = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	expect(
		s.ghCalls.find(
			(a) =>
				a[1] === "create" &&
				a.includes("portia/ACME-0") &&
				a.includes("--head") &&
				a.includes("portia/ACME-2"),
		),
	).toEqual(expect.arrayContaining(["--title", prTitle(plan, child2)]));
	const created =
		s.ghCalls.find((a) => a[1] === "create" && a.includes("portia/ACME-2")) ??
		[];
	expect(created[created.indexOf("--body") + 1]).toBe(
		"Part of ACME-0.\n\nRequirements: F1",
	);
	expect(s.ghCalls.find((a) => a[1] === "merge")).toEqual([
		"pr",
		"merge",
		"42",
		"--squash",
		"--match-head-commit",
		sha,
	]);
	expect(lastLanded(s.dir)).toMatchObject({
		child: "ACME-2",
		stage: "landed",
		data: { pr: 42, sha },
	});
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		child: "ACME-2",
		stage: "tracker",
		status: "transitioned",
	});
	expect(prTitle(plan, child2)).toBe(
		"feat(onboarding): ACME-0 ACME-2 Set-up rules",
	);
});

it("parks a child whose rebase conflicts, leaving the worktree clean", async () => {
	const s = await setup();
	writeFileSync(join(s.wt, "a.txt"), "child\n");
	await s.g(s.wt, "commit", "-am", "child edits a");
	const integ = integrationWorktree(s.ctx.profile, "ACME-0");
	writeFileSync(join(integ, "a.txt"), "integration\n");
	await s.g(integ, "commit", "-am", "integration edits a");
	await s.g(integ, "push", "origin", "HEAD:portia/ACME-0");
	expect(await land("ACME-2", s.ctx)).toMatchObject({ status: "parked" });
	expect((await s.g(s.wt, "status", "--porcelain")).trim()).toBe("");
});

it("fails a child whose exit gate fails on the rebased head (R6)", async () => {
	const s = await setup(async () => ({
		kind: "exit" as const,
		ok: false,
		steps: [{ name: "unit", ok: false, tail: "1 failed" }],
	}));
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("unit"),
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("refuses to push a child whose head adds a secret, even when its gate passed, without echoing it", async () => {
	const s = await setup();
	const key = `sk${"_live_"}Q3tZ7rKx2M5vB8nWp4Ls9Hd6`;
	writeFileSync(join(s.wt, "pay.ts"), `const ok = 1;\nconst k = "${key}";\n`);
	await s.g(s.wt, "add", ".");
	await s.g(s.wt, "commit", "-m", "child work");
	const out = await land("ACME-2", s.ctx);
	expect(out).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("secret stripe-live-key: pay.ts:2"),
	});
	expect(JSON.stringify(out)).not.toContain(key);
	expect(await s.g(s.repo, "ls-remote", "origin", "portia/ACME-2")).toBe("");
	expect(
		s.ghCalls.some(
			(a) =>
				(a[1] === "create" && a.includes("portia/ACME-2")) || a[1] === "merge",
		),
	).toBe(false);
});

it("a second landing of the same child refuses at once rather than racing (Review focus 1)", async () => {
	const slowGate = async () => {
		await new Promise((r) => setTimeout(r, 300));
		return { kind: "exit" as const, ok: true, steps: [] };
	};
	const s = await setup(slowGate);
	s.ctx.lockOpts = { timeoutMs: 10_000, pollMs: 10 };
	const first = land("ACME-2", s.ctx);
	await new Promise((r) => setTimeout(r, 20));
	expect(landRunning(s.dir, "ACME-2")).toBe(process.pid);
	await expect(land("ACME-2", s.ctx)).rejects.toThrow(
		`a land of ACME-2 is already running (pid ${process.pid})`,
	);
	expect((await first).status).toBe("landed");
	expect(landRunning(s.dir, "ACME-2")).toBeUndefined();
});

/**
 * Hold land.lock until `release()` is called. Deterministic on purpose: a fixed-duration hold
 * races with real git work (slow under machine load) and the test silently stops testing
 * contention. withLock takes the lock synchronously, so it is held when this returns.
 */
function holdLandLock(dir: string) {
	let release = () => {};
	const held = withLock(
		dir,
		() =>
			new Promise<void>((r) => {
				release = r;
			}),
		{ name: "land.lock" },
	);
	return { held, release: () => release() };
}

async function childWithCommit(s: Awaited<ReturnType<typeof setup>>) {
	writeFileSync(join(s.wt, "b.txt"), "child\n");
	await s.g(s.wt, "add", ".");
	await s.g(s.wt, "commit", "-m", "child work");
}

const checksJson = (rows: { name: string; bucket: string }[]) => ({
	stdout: JSON.stringify(rows),
});
const ghWithChecks =
	(checks: (args: string[]) => Partial<ExecResult>) => (args: string[]) =>
		args[1] === "checks" ? checks(args) : gh(args);

it("waits for CI checks to register, then polls them to green", async () => {
	let polls = 0;
	const s = await setup(passGate, {
		gh: ghWithChecks(() =>
			polls++ < 2
				? { code: 1, stderr: "no checks reported on the branch" }
				: polls < 5
					? checksJson([{ name: "unit", bucket: "pending" }])
					: checksJson([
							{ name: "unit", bucket: "pass" },
							{ name: "lint", bucket: "skipping" },
						]),
		),
	});
	await childWithCommit(s);
	expect(
		(await land("ACME-2", { ...s.ctx, checksWaitMs: 60_000 })).status,
	).toBe("landed");
	expect(polls).toBeGreaterThan(4);
	expect(s.ghCalls.some((a) => a[1] === "checks")).toBe(false);
	expect(s.ghCalls.find(isPoll)).toEqual([
		"pr",
		"view",
		"42",
		"--json",
		"headRefOid,statusCheckRollup",
	]);
});

it("fails when no CI checks ever appear", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() => ({ code: 1, stderr: "No checks reported" })),
	});
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("no CI checks appeared on PR #42"),
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("with ci false, lands without waiting on checks that never appear", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() => ({ code: 1, stderr: "No checks reported" })),
	});
	s.ctx.profile.ci = false;
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(s.ghCalls.some(isPoll)).toBe(false);
});

it("opens the PR before the exit gate, so CI runs alongside it, and a failing gate stops the wait", async () => {
	let created = false;
	let polledDuringGate = 0;
	let s: Awaited<ReturnType<typeof setup>> | undefined;
	s = await setup(async () => {
		created = !!s?.ghCalls.some((a) => a[1] === "create");
		await new Promise((r) => setTimeout(r, 40));
		polledDuringGate = s?.ghCalls.filter(isPoll).length ?? 0;
		return {
			kind: "exit" as const,
			ok: false,
			steps: [{ name: "unit", ok: false, tail: "1 failed" }],
		};
	});
	s.ctx.checksWaitMs = 60_000;
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({ status: "failed" });
	expect(created).toBe(true);
	expect(polledDuringGate).toBeGreaterThan(0);
	const after = s.ghCalls.filter(isPoll).length;
	await new Promise((r) => setTimeout(r, 30));
	expect(s.ghCalls.filter(isPoll).length).toBe(after);
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("fails naming the failing and cancelled checks", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() => ({
			code: 1,
			...checksJson([
				{ name: "unit", bucket: "fail" },
				{ name: "e2e", bucket: "cancel" },
				{ name: "lint", bucket: "pass" },
				{ name: "slow", bucket: "pending" },
			]),
		})),
	});
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toEqual({
		status: "failed",
		reason: "CI failed on PR #42: unit, e2e",
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("fails when a check is still pending past checksTimeoutMin", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() => checksJson([{ name: "unit", bucket: "pending" }])),
	});
	s.ctx.profile.checksTimeoutMin = 0.0005;
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toEqual({
		status: "failed",
		reason: "CI on PR #42 still pending after 0.0005 min",
		infra: true,
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("times out when gh starts failing after checks were seen, naming the gh error", async () => {
	let n = 0;
	const s = await setup(passGate, {
		gh: ghWithChecks(() =>
			n++ === 0
				? checksJson([{ name: "unit", bucket: "pending" }])
				: { code: 1, stderr: "HTTP 401: bad credentials" },
		),
	});
	s.ctx.profile.checksTimeoutMin = 0.0005;
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toEqual({
		status: "failed",
		reason:
			"CI on PR #42 still pending after 0.0005 min (last gh error: HTTP 401: bad credentials)",
		infra: true,
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("names the gh error when no checks ever register", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() => ({ code: 4, stderr: "gh auth login required" })),
	});
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("last gh error: gh auth login required"),
	});
});

it("skips the CI wait in dry run", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() => ({ code: 1, stderr: "No checks reported" })),
	});
	await childWithCommit(s);
	process.env.PORTIA_DRY_RUN = "1";
	try {
		await land("ACME-2", s.ctx);
	} finally {
		delete process.env.PORTIA_DRY_RUN;
	}
	expect(s.ghCalls.some(isPoll)).toBe(false);
});

const runList = (rows: { status: string; headSha: string }[]) => ({
	stdout: JSON.stringify(rows),
});

it("keeps waiting for a missing check while a CI run for the head is in progress", async () => {
	let head = "";
	let polls = 0;
	let runLists = 0;
	const s = await setup(passGate, {
		gh: (args) => {
			if (args[0] === "run") {
				runLists++;
				return runList([
					{ status: "completed", headSha: "an-older-push" },
					{ status: "in_progress", headSha: head },
				]);
			}
			if (args[1] === "checks")
				return polls++ < 10
					? { code: 1, stderr: "no checks reported on the branch" }
					: checksJson([{ name: "unit", bucket: "pass" }]);
			return gh(args);
		},
	});
	await childWithCommit(s);
	head = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	const out = await land("ACME-2", {
		...s.ctx,
		checksWaitMs: 60_000,
		checksGraceMs: 1,
	});
	expect(out.status).toBe("landed");
	expect(runLists).toBeGreaterThan(0);
	expect(s.ghCalls.find((a) => a[0] === "run")).toEqual(
		expect.arrayContaining([
			"list",
			"--branch",
			"portia/ACME-2",
			"--json",
			"status,headSha",
		]),
	);
});

it("fails a missing check early once no CI run for the head is active", async () => {
	let head = "";
	const s = await setup(passGate, {
		gh: (args) =>
			args[0] === "run"
				? runList([
						{ status: "in_progress", headSha: "an-older-push" },
						{ status: "completed", headSha: head },
					])
				: args[1] === "checks"
					? checksJson([{ name: "unit", bucket: "pass" }])
					: gh(args),
	});
	s.ctx.profile.ciChecks = ["CI gate"];
	await childWithCommit(s);
	head = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	const started = Date.now();
	const out = await land("ACME-2", {
		...s.ctx,
		checksWaitMs: 60_000,
		checksGraceMs: 1,
	});
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(out).toMatchObject({
		status: "failed",
		reason: "CI check CI gate never appeared on PR #42 before CI finished",
	});
});

it("no Actions run for the head counts as CI still running", async () => {
	let polls = 0;
	const s = await setup(passGate, {
		gh: (args) =>
			args[0] === "run"
				? runList([{ status: "completed", headSha: "an-older-push" }])
				: args[1] === "checks"
					? polls++ < 5
						? checksJson([{ name: "unit", bucket: "pass" }])
						: checksJson([
								{ name: "unit", bucket: "pass" },
								{ name: "Preview", bucket: "pass" },
							])
					: gh(args),
	});
	s.ctx.profile.ciChecks = ["Preview"];
	await childWithCommit(s);
	const out = await land("ACME-2", {
		...s.ctx,
		checksWaitMs: 60_000,
		checksGraceMs: 1,
	});
	expect(out.status).toBe("landed");
});

it("an unreadable run list counts as CI still running", async () => {
	let polls = 0;
	const s = await setup(passGate, {
		gh: (args) =>
			args[0] === "run"
				? { code: 1, stderr: "HTTP 502" }
				: args[1] === "checks"
					? polls++ < 5
						? { code: 1, stderr: "no checks reported on the branch" }
						: checksJson([{ name: "unit", bucket: "pass" }])
					: gh(args),
	});
	await childWithCommit(s);
	const out = await land("ACME-2", {
		...s.ctx,
		checksWaitMs: 60_000,
		checksGraceMs: 1,
	});
	expect(out.status).toBe("landed");
});

it("waits ciWaitMs from the profile: 5 min by default, 45 for Acme", () => {
	expect(testProfile().ciWaitMs).toBe(5 * 60_000);
	expect(ProfileSchema.parse(acme).ciWaitMs).toBe(45 * 60_000);
});

it("defaults checksTimeoutMin to 45", () => {
	expect(testProfile().checksTimeoutMin).toBe(45);
});

it("does not hold land.lock while waiting on CI or moving the ticket, but holds it for the merge and run-log row", async () => {
	const lockFile = (dir: string) => join(dir, "land.lock");
	let dir = "";
	const heldDuringChecks: boolean[] = [];
	const heldDuringMerge: boolean[] = [];
	const heldDuringTransition: boolean[] = [];
	const tracker = new (class extends FakeTracker {
		async transition(key: string, state: string): Promise<void> {
			heldDuringTransition.push(existsSync(lockFile(dir)));
			return super.transition(key, state);
		}
	})();
	const s = await setup(passGate, {
		tracker,
		gh: (args) => {
			if (args[1] === "checks") {
				heldDuringChecks.push(existsSync(lockFile(dir)));
				return checksJson([{ name: "unit", bucket: "pass" }]);
			}
			if (args[1] === "merge") heldDuringMerge.push(existsSync(lockFile(dir)));
			return gh(args);
		},
	});
	dir = s.dir;
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(heldDuringChecks).toEqual([false]);
	expect(heldDuringMerge).toEqual([true]);
	expect(heldDuringTransition).toEqual([false]);
});

it("a second child rebases, gates and pushes while the first waits on CI, and both merge", async () => {
	let calls: string[][] = [];
	const s = await setup(passGate, {
		gh: (args) => {
			if (args[1] === "list") return { stdout: "[]" };
			if (args[1] === "create")
				return {
					stdout: `https://github.com/o/r/pull/${args.includes("portia/ACME-3") ? 43 : 42}\n`,
				};
			if (args[1] === "checks") {
				// PR 42 stays pending until ACME-3's PR exists; if the lock were held through CI this would deadlock.
				const sv3Created = calls.some(
					(a) => a[1] === "create" && a.includes("portia/ACME-3"),
				);
				return checksJson([
					{
						name: "unit",
						bucket: args[2] === "42" && !sv3Created ? "pending" : "pass",
					},
				]);
			}
			return {};
		},
	});
	calls = s.ghCalls;
	const wt3 = join(s.ctx.profile.worktreesDir, s.ctx.profile.repo, "ACME-3");
	await s.g(
		s.repo,
		"worktree",
		"add",
		"-B",
		"portia/ACME-3",
		wt3,
		"origin/portia/ACME-0",
	);
	writeFileSync(
		join(s.dir, "env-ACME-3.json"),
		JSON.stringify({
			worktree: wt3,
			branch: "portia/ACME-3",
			db: "d",
			port: 2,
			envFile: "/x",
		}),
	);
	await childWithCommit(s);
	writeFileSync(join(wt3, "c.txt"), "child3\n");
	await s.g(wt3, "add", ".");
	await s.g(wt3, "commit", "-m", "child 3 work");
	s.ctx.profile.checksTimeoutMin = 0.05;
	s.ctx.lockOpts = { timeoutMs: 10_000, pollMs: 10 };
	const first = land("ACME-2", s.ctx);
	await new Promise((r) => setTimeout(r, 30));
	const second = land("ACME-3", s.ctx);
	expect([(await first).status, (await second).status]).toEqual([
		"landed",
		"landed",
	]);
	const merges = s.ghCalls.filter((a) => a[1] === "merge").map((a) => a[2]);
	expect(merges.sort()).toEqual(["42", "43"]);
	const idx = (pred: (a: string[]) => boolean) => s.ghCalls.findIndex(pred);
	expect(
		idx((a) => a[1] === "create" && a.includes("portia/ACME-3")),
	).toBeLessThan(idx((a) => a[1] === "merge" && a[2] === "42"));
});

it("records a failed tracker transition without failing the landing", async () => {
	const s = await setup(passGate, {
		tracker: new (class extends FakeTracker {
			async transition(): Promise<void> {
				throw new Error("no transition named Review/QA");
			}
		})(),
	});
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	const landed = readRows(s.dir).rows.filter((r) => r.stage === "landed");
	expect(landed).toHaveLength(1);
	expect(landed[0]?.data).toMatchObject({ pr: 42, tracker: "pending" });
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		stage: "tracker",
		status: "failed",
		data: { jiraError: "no transition named Review/QA" },
	});
});

it("main sync waits for a landing in progress (land.lock)", async () => {
	const s = await setup();
	const { held, release } = holdLandLock(s.dir);
	await expect(syncMain(s.ctx)).rejects.toBeInstanceOf(PortiaProblem);
	release();
	await held;
});

it("a landing does not block an unrelated heavy-lock caller", async () => {
	let release = () => {};
	let inGate = () => {};
	const reachedGate = new Promise<void>((res) => {
		inGate = res;
	});
	const gate = () =>
		new Promise<GateReport>((res) => {
			release = () => res({ kind: "exit", ok: true, steps: [] });
			inGate();
		});
	const s = await setup(gate);
	await childWithCommit(s);
	const landing = land("ACME-2", s.ctx);
	await reachedGate;
	expect(
		await withLock(s.dir, async () => "heavy ran", {
			timeoutMs: 100,
			pollMs: 10,
		}),
	).toBe("heavy ran");
	release();
	expect((await landing).status).toBe("landed");
});

it("two landings still serialise", async () => {
	const s = await setup();
	const { held, release } = holdLandLock(s.dir);
	await childWithCommit(s);
	await expect(land("ACME-2", s.ctx)).rejects.toBeInstanceOf(PortiaProblem);
	release();
	await held;
});

it("a dry-run land merges nothing, records nothing and keeps the child's env", async () => {
	const tracker = new FakeTracker().add({
		key: "ACME-2",
		summary: "Set-up rules",
		description: "",
		blockedBy: [],
	});
	const s = await setup(passGate, { tracker });
	await childWithCommit(s);
	const before = readRows(s.dir).rows.length;
	const logged: string[] = [];
	const spy = vi
		.spyOn(console, "error")
		.mockImplementation((m: unknown) => void logged.push(String(m)));
	process.env.PORTIA_DRY_RUN = "1";
	try {
		const out = await land("ACME-2", s.ctx);
		expect(out).toMatchObject({ status: "landed", pr: 42 });
		await afterLand(s.ctx, "ACME-2", "ACME-0", out);
	} finally {
		delete process.env.PORTIA_DRY_RUN;
		spy.mockRestore();
	}
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
	expect(readRows(s.dir).rows).toHaveLength(before);
	expect(tracker.writes.filter((w) => w.kind === "transition")).toEqual([]);
	expect(existsSync(join(s.dir, "env-ACME-2.json"))).toBe(true);
	expect(existsSync(s.wt)).toBe(true);
	expect(logged).toContain(
		"[dry-run] would merge PR #42, transition and record landed",
	);
});

it("defaults ciChecks to [] (every check gates); Acme gates on its CI gate only", async () => {
	expect(testProfile().ciChecks).toEqual([]);
	const acme = (await import("../fixtures/profile")).default;
	expect(acme.ciChecks).toEqual(["CI gate"]);
});

it("with ciChecks set, an unlisted failing check does not fail the land", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() =>
			checksJson([
				{ name: "🏁 CI gate", bucket: "pass" },
				{ name: "advisory-lighthouse", bucket: "fail" },
				{ name: "storybook-preview", bucket: "pending" },
			]),
		),
	});
	s.ctx.profile.ciChecks = ["🏁 CI gate"];
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
});

it("with ciChecks set, a listed failing check fails the land", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() =>
			checksJson([
				{ name: "🏁 CI gate", bucket: "fail" },
				{ name: "unit", bucket: "pass" },
			]),
		),
	});
	s.ctx.profile.ciChecks = ["🏁 CI gate"];
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: "CI failed on PR #42: 🏁 CI gate",
	});
});

it("with ciChecks set, a listed check that never registers fails at the registration deadline, named", async () => {
	const s = await setup(passGate, {
		gh: ghWithChecks(() => checksJson([{ name: "unit", bucket: "pass" }])),
	});
	s.ctx.profile.ciChecks = ["🏁 CI gate"];
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("🏁 CI gate"),
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("an R6 failure carries the tail of the first failing step's output", async () => {
	const out = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
	const s = await setup(async () => ({
		kind: "exit" as const,
		ok: false,
		steps: [
			{ name: "lint", ok: true, tail: "" },
			{ name: "unit", ok: false, tail: out },
		],
	}));
	const r = await land("ACME-2", s.ctx);
	if (r.status !== "failed") throw new Error(r.status);
	expect(r.reason).toContain("exit gate failed on the rebased head (R6): unit");
	expect(r.reason).toContain("line 40");
	expect(r.reason).toContain("line 21");
	expect(r.reason).not.toContain("line 20\n");
	const long = await setup(async () => ({
		kind: "exit" as const,
		ok: false,
		steps: [{ name: "unit", ok: false, tail: "x".repeat(10_000) }],
	}));
	const r2 = await land("ACME-2", long.ctx);
	if (r2.status !== "failed") throw new Error(r2.status);
	expect(r2.reason.length).toBeLessThan(2_200);
});

const review = (cmd: string, o: { onFindings?: "fail" | "park" } = {}) => ({
	child: { cmd, timeoutMs: 10_000, onFindings: o.onFindings ?? "fail" },
});

it("with no review configured, a land runs no review and logs none", async () => {
	const s = await setup();
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(readRows(s.dir).rows.some((r) => r.stage === "review")).toBe(false);
	expect(existsSync(join(s.dir, "review-ACME-2.diff"))).toBe(false);
});

it("reviews the child at the gated head, with its diff and keys in the env, before it merges", async () => {
	const s = await setup();
	s.ctx.profile.review = review(
		'test "$(git rev-parse HEAD)" = "$PORTIA_HEAD_SHA" && test "$(pwd -P)" = "$(cd "$PORTIA_WORKTREE" && pwd -P)" && grep -q "^+child" "$PORTIA_DIFF" && test "$PORTIA_CHILD $PORTIA_PARENT" = "ACME-2 ACME-0" && echo \'{"findings":[]}\'',
	);
	await childWithCommit(s);
	const out = await land("ACME-2", s.ctx);
	expect(out.status).toBe("landed");
	const sha = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	const base = (await s.g(s.wt, "rev-parse", "origin/portia/ACME-0")).trim();
	const rows = readRows(s.dir).rows;
	const reviewed = rows.findIndex((r) => r.stage === "review");
	expect(rows[reviewed]).toMatchObject({
		child: "ACME-2",
		status: "clean",
		data: { base, head: sha, exit: 0, findings: [] },
	});
	expect(reviewed).toBeLessThan(rows.findIndex((r) => r.stage === "landed"));
});

it("findings fail the land unmerged, and the retry's brief carries them", async () => {
	const s = await setup();
	s.ctx.profile.review = review(
		'echo "scanning"; echo \'{"findings":[{"severity":"high","message":"unchecked input","file":"b.txt","line":1}]}\'; exit 1',
	);
	await childWithCommit(s);
	const out = await land("ACME-2", s.ctx);
	expect(out).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("- [high] b.txt:1 unchecked input"),
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
	await afterLand(s.ctx, "ACME-2", "ACME-0", out);
	expect(readRows(s.dir).rows.at(-2)).toMatchObject({
		stage: "review",
		status: "findings",
	});
	const brief = previousAttempt(readRows(s.dir).rows, "ACME-2");
	expect(brief).toContain("the child review found 1 finding at");
	expect(brief).toContain("- [high] b.txt:1 unchecked input");
});

it("findings park the child when the profile says onFindings: park", async () => {
	const s = await setup();
	s.ctx.profile.review = review("echo risky; exit 1", { onFindings: "park" });
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "parked",
		reason: expect.stringContaining("risky"),
	});
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(false);
});

it("a review that cannot run parks the child rather than landing it", async () => {
	const s = await setup();
	s.ctx.profile.review = review("exit 2");
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "parked",
		reason: expect.stringContaining("could not run (exit 2)"),
	});
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		stage: "review",
		status: "error",
	});
});

it("parked findings reach the next brief, tagged in the run log, and republish the ledger", async () => {
	const s = await setup();
	s.ctx.profile.review = review(
		'echo \'{"findings":[{"message":"unchecked input"}]}\'; exit 1',
		{ onFindings: "park" },
	);
	await childWithCommit(s);
	const out = await land("ACME-2", s.ctx);
	expect(out).toMatchObject({ status: "parked", review: "findings" });
	await afterLand(s.ctx, "ACME-2", "ACME-0", out);
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		stage: "land",
		status: "parked",
		data: { review: "findings" },
	});
	const brief = previousAttempt(readRows(s.dir).rows, "ACME-2");
	expect(brief).toContain("was parked: the child review found 1 finding at");
	expect(brief).toContain("- unchecked input");
	expect(
		s.ghCalls.some((a) => a[1] === "edit" && a.includes("--body-file")),
	).toBe(true);
});

it("a land blocked by anything but the review leaves the ledger alone", async () => {
	const s = await setup();
	const before = s.ghCalls.length;
	await afterLand(s.ctx, "ACME-2", "ACME-0", {
		status: "failed",
		reason: "CI failed",
	});
	expect(s.ghCalls.slice(before).some((a) => a[1] === "edit")).toBe(false);
});

it("a review error is tagged so the skill can land again once the command is fixed", async () => {
	const s = await setup();
	s.ctx.profile.review = review("exit 2");
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "parked",
		review: "error",
	});
});

it("a dry run skips the child review and still lands", async () => {
	const s = await setup();
	const marker = join(s.root, "reviewed");
	s.ctx.profile.review = review(`touch ${marker}; exit 1`);
	await childWithCommit(s);
	const logged: string[] = [];
	const spy = vi
		.spyOn(console, "error")
		.mockImplementation((m: unknown) => void logged.push(String(m)));
	process.env.PORTIA_DRY_RUN = "1";
	try {
		expect(await land("ACME-2", s.ctx)).toMatchObject({ status: "landed" });
	} finally {
		delete process.env.PORTIA_DRY_RUN;
		spy.mockRestore();
	}
	expect(existsSync(marker)).toBe(false);
	expect(readRows(s.dir).rows.some((r) => r.stage === "review")).toBe(false);
	expect(logged).toContain("[dry-run] skip the child review of ACME-2");
});

/** Run `hook` once, just after the first CI poll: after the gate and push, before the merge. */
function afterFirstCheck(
	s: Awaited<ReturnType<typeof setup>>,
	hook: () => Promise<void>,
) {
	const inner = s.ctx.exec;
	let ran = false;
	s.ctx.exec = async (cmd, args, opts) => {
		if (cmd !== "gh" || !isPoll(args) || ran) return inner(cmd, args, opts);
		ran = true;
		// The poll has read the PR at the gated head; the push lands just after it.
		const r = await inner(cmd, args, opts);
		await hook();
		return r;
	};
}

/** A clone outside the run that pushes `file` onto `branch`, as a person or another tool would. */
async function pushElsewhere(
	s: Awaited<ReturnType<typeof setup>>,
	branch: string,
	file: string,
	opts: { force?: boolean } = {},
): Promise<string> {
	const other = mkdtempSync(join(s.root, "other-"));
	await s.g(s.root, "clone", "-q", join(s.root, "origin.git"), other);
	await s.g(other, "config", "user.email", "o@example.com");
	await s.g(other, "config", "user.name", "Other");
	await s.g(other, "checkout", "-q", branch);
	if (opts.force) await s.g(other, "reset", "-q", "--hard", "HEAD~1");
	writeFileSync(join(other, file), `${file}\n`);
	await s.g(other, "add", ".");
	await s.g(other, "commit", "-qm", `push ${file}`);
	await s.g(other, "push", ...(opts.force ? ["-f"] : []), "origin", branch);
	return (await s.g(other, "rev-parse", "HEAD")).trim();
}

const countingGate = () => {
	const gate = Object.assign(
		async (): Promise<GateReport> => {
			gate.runs++;
			return { kind: "exit", ok: true, steps: [] };
		},
		{ runs: 0 },
	);
	return gate;
};
const mergeCalls = (s: { ghCalls: string[][] }) =>
	s.ghCalls.filter((a) => a[1] === "merge");

it("a commit pushed to the child branch between gate and land is gated before anything merges", async () => {
	const gate = countingGate();
	const s = await setup(gate);
	await childWithCommit(s);
	const gated = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	let pushed = "";
	afterFirstCheck(s, async () => {
		pushed = await pushElsewhere(s, "portia/ACME-2", "late.txt");
	});
	const out = await land("ACME-2", s.ctx);
	expect(out).toMatchObject({ status: "landed", sha: pushed });
	expect(pushed).not.toBe(gated);
	expect(gate.runs).toBe(2);
	expect(mergeCalls(s)).toEqual([
		["pr", "merge", "42", "--squash", "--match-head-commit", pushed],
	]);
	expect(lastLanded(s.dir)).toMatchObject({
		stage: "landed",
		data: { sha: pushed },
	});
});

it("a child branch rewritten after its gate fails the land and merges nothing", async () => {
	const s = await setup();
	await childWithCommit(s);
	const gated = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	afterFirstCheck(s, async () => {
		await pushElsewhere(s, "portia/ACME-2", "other.txt", { force: true });
	});
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: expect.stringContaining(gated),
	});
	expect(mergeCalls(s)).toEqual([]);
	const rewritten = (
		await s.g(s.repo, "ls-remote", "origin", "refs/heads/portia/ACME-2")
	).split(/\s/)[0];
	await expect(land("ACME-2", s.ctx)).rejects.toBeInstanceOf(PortiaProblem);
	expect(
		(
			await s.g(s.repo, "ls-remote", "origin", "refs/heads/portia/ACME-2")
		).split(/\s/)[0],
	).toBe(rewritten);
	expect(mergeCalls(s)).toEqual([]);
});

const rollupOf = (head: string, conclusion: string) => ({
	stdout: JSON.stringify({
		headRefOid: head,
		statusCheckRollup: [
			{ __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion },
		],
	}),
});

it("does not trust checks until the PR's head is the gated sha", async () => {
	let polls = 0;
	const s = await setup(passGate, {
		gh: (args) =>
			isPoll(args) && ++polls <= 3
				? rollupOf("the-previous-head", "FAILURE")
				: gh(args),
	});
	await childWithCommit(s);
	const out = await land("ACME-2", s.ctx);
	expect(out.status).toBe("landed");
	expect(polls).toBeGreaterThan(3);
	expect(mergeCalls(s)).toHaveLength(1);
});

it("a stale green rollup from the previous head after a re-gate push merges nothing", async () => {
	let sha = "";
	const s = await setup(countingGate(), {
		gh: (args) => (isPoll(args) && sha ? rollupOf(sha, "SUCCESS") : gh(args)),
	});
	await childWithCommit(s);
	sha = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	afterFirstCheck(s, async () => {
		await pushElsewhere(s, "portia/ACME-2", "late.txt");
	});
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: expect.stringContaining(`PR #42's head is ${sha}`),
	});
	expect(mergeCalls(s)).toEqual([]);
});

it("a merge GitHub refuses at the pinned head fails with nothing landed", async () => {
	const s = await setup(passGate, {
		gh: (args) =>
			args[1] === "merge"
				? {
						code: 1,
						stderr: "Head branch was modified. Review and try the merge again.",
					}
				: gh(args),
	});
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("Head branch was modified"),
	});
	expect(readRows(s.dir).rows.some((r) => r.stage === "landed")).toBe(false);
});

it("a commit made in the worktree while the gate runs is gated before it is pushed", async () => {
	let wt = "";
	let runs = 0;
	const s = await setup(async () => {
		if (runs++ === 0) {
			writeFileSync(join(wt, "during.txt"), "during\n");
			await realGit(wt, "add", ".");
			await realGit(wt, "commit", "-qm", "during the gate");
		}
		return { kind: "exit", ok: true, steps: [] };
	});
	wt = s.wt;
	await childWithCommit(s);
	const out = await land("ACME-2", s.ctx);
	const head = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	expect(out).toMatchObject({ status: "landed", sha: head });
	expect(runs).toBe(2);
	expect(mergeCalls(s)).toHaveLength(1);
	expect(mergeCalls(s)[0]?.at(-1)).toBe(head);
});

it("a head that keeps changing after each gate parks rather than re-gating forever", async () => {
	let wt = "";
	let runs = 0;
	const s = await setup(async () => {
		writeFileSync(join(wt, `during-${runs}.txt`), "x\n");
		runs++;
		await realGit(wt, "add", ".");
		await realGit(wt, "commit", "-qm", "again");
		return { kind: "exit", ok: true, steps: [] };
	});
	wt = s.wt;
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "parked",
		reason: expect.stringContaining(`re-gated ${MAX_REGATES} times`),
	});
	expect(runs).toBe(MAX_REGATES + 1);
	expect(mergeCalls(s)).toEqual([]);
});

/** Another child landing on the integration branch while this one waits on CI. */
const landElsewhere = (s: Awaited<ReturnType<typeof setup>>) =>
	pushElsewhere(s, "portia/ACME-0", "sibling.txt");

it("by default, an integration tip that moves after the gate does not re-gate", async () => {
	const gate = countingGate();
	const s = await setup(gate);
	await childWithCommit(s);
	afterFirstCheck(s, async () => {
		await landElsewhere(s);
	});
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(gate.runs).toBe(1);
	expect(mergeCalls(s)).toHaveLength(1);
});

it("with landOnGatedTip, an integration tip that moves after the gate is rebased onto and gated again", async () => {
	const gate = countingGate();
	const s = await setup(gate);
	s.ctx.profile.landOnGatedTip = true;
	await childWithCommit(s);
	let tip = "";
	afterFirstCheck(s, async () => {
		tip = await landElsewhere(s);
	});
	const out = await land("ACME-2", s.ctx);
	const head = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	expect(out).toMatchObject({ status: "landed", sha: head });
	expect(gate.runs).toBe(2);
	expect((await s.g(s.wt, "rev-parse", "HEAD~1")).trim()).toBe(tip);
	expect(mergeCalls(s)).toEqual([
		["pr", "merge", "42", "--squash", "--match-head-commit", head],
	]);
	expect(lastLanded(s.dir)).toMatchObject({
		stage: "landed",
		data: { sha: head, onto: tip },
	});
});

it("defaults landOnGatedTip to false", () => {
	expect(testProfile().landOnGatedTip).toBe(false);
});

it("defaults regressionGuard to true", () => {
	expect(testProfile().regressionGuard).toBe(true);
});

it("with landOnGatedTip, a tip that keeps moving is beaten by a last attempt that holds land.lock through CI", async () => {
	const gate = countingGate();
	const lockHeld = () => existsSync(join(s.dir, "land.lock"));
	const heldDuringChecks: boolean[] = [];
	const s = await setup(gate, {
		gh: (args) => {
			if (args[1] === "checks") heldDuringChecks.push(lockHeld());
			return gh(args);
		},
	});
	s.ctx.profile.landOnGatedTip = true;
	await childWithCommit(s);
	const inner = s.ctx.exec;
	let n = 0;
	s.ctx.exec = async (cmd, args, opts) => {
		// A sibling can only land while land.lock is free.
		if (cmd === "gh" && isPoll(args) && !lockHeld())
			await pushElsewhere(s, "portia/ACME-0", `sibling-${n++}.txt`);
		return inner(cmd, args, opts);
	};
	const out = await land("ACME-2", s.ctx);
	expect(out.status).toBe("landed");
	expect(gate.runs).toBe(MAX_REGATES + 1);
	expect(heldDuringChecks.at(-1)).toBe(true);
	expect(mergeCalls(s)).toHaveLength(1);
}, 120_000);

it("a commit pushed after the gate is reviewed again at the new head before it merges", async () => {
	const s = await setup(countingGate());
	const heads = join(s.root, "reviewed-heads");
	s.ctx.profile.review = review(
		`echo "$PORTIA_HEAD_SHA" >> ${heads}; echo '{"findings":[]}'`,
	);
	await childWithCommit(s);
	const gated = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	let pushed = "";
	afterFirstCheck(s, async () => {
		pushed = await pushElsewhere(s, "portia/ACME-2", "late.txt");
	});
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "landed",
		sha: pushed,
	});
	expect(readFileSync(heads, "utf8").trim().split("\n")).toEqual([
		gated,
		pushed,
	]);
	expect(mergeCalls(s)).toEqual([
		["pr", "merge", "42", "--squash", "--match-head-commit", pushed],
	]);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const passing = checksJson([{ name: "unit", bucket: "pass" }]);

it("buckets rollup entries as gh pr checks does, CheckRuns and StatusContexts alike", () => {
	const run = (status: string, conclusion?: string) => ({
		__typename: "CheckRun",
		name: "unit",
		status,
		conclusion,
	});
	expect(bucketOf(run("COMPLETED", "SUCCESS"))).toBe("pass");
	expect(bucketOf(run("COMPLETED", "NEUTRAL"))).toBe("skipping");
	expect(bucketOf(run("COMPLETED", "SKIPPED"))).toBe("skipping");
	for (const c of [
		"FAILURE",
		"TIMED_OUT",
		"ACTION_REQUIRED",
		"STARTUP_FAILURE",
	])
		expect(bucketOf(run("COMPLETED", c))).toBe("fail");
	expect(bucketOf(run("COMPLETED", "CANCELLED"))).toBe("cancel");
	for (const st of ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"])
		expect(bucketOf(run(st))).toBe("pending");
	const status = (state: string) => ({
		__typename: "StatusContext",
		context: "ci/vercel",
		state,
	});
	expect(bucketOf(status("SUCCESS"))).toBe("pass");
	expect(bucketOf(status("FAILURE"))).toBe("fail");
	expect(bucketOf(status("ERROR"))).toBe("fail");
	expect(bucketOf(status("PENDING"))).toBe("pending");
	expect(bucketOf(status("EXPECTED"))).toBe("pending");
});

it("names a StatusContext by its context and counts a re-run check by its latest run only", () => {
	expect(
		rollupChecks([
			{
				name: "unit",
				workflowName: "CI",
				status: "COMPLETED",
				conclusion: "FAILURE",
				startedAt: "2026-10-01T10:00:00Z",
			},
			{
				name: "unit",
				workflowName: "CI",
				status: "COMPLETED",
				conclusion: "SUCCESS",
				startedAt: "2026-10-01T10:05:00Z",
			},
			{
				name: "unit",
				workflowName: "Nightly",
				status: "IN_PROGRESS",
				startedAt: "2026-10-01T09:00:00Z",
			},
			{
				context: "ci/vercel",
				state: "SUCCESS",
				startedAt: "2026-10-01T10:01:00Z",
			},
		]),
	).toEqual([
		{ name: "unit", bucket: "pass" },
		{ name: "ci/vercel", bucket: "pass" },
		{ name: "unit", bucket: "pending" },
	]);
});

const mergeAnswers =
	(stderr: string, state: string) =>
	(args: string[]): Partial<ExecResult> =>
		args[1] === "merge"
			? { code: 1, stderr }
			: args[1] === "view" && args.at(-1) === "state"
				? { stdout: JSON.stringify({ state }) }
				: gh(args);

it("a merge GitHub applied but whose answer was lost is recorded as landed", async () => {
	const s = await setup(passGate, {
		gh: mergeAnswers("HTTP 502: Bad Gateway", "MERGED"),
	});
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({
		status: "landed",
		pr: 42,
	});
	expect(lastLanded(s.dir)).toMatchObject({
		child: "ACME-2",
		data: { pr: 42 },
	});
	expect(s.ctx.tracker.writes).toHaveLength(1);
});

it("a merge refused for anything but a moved head is CI or GitHub's failure, not the child's", async () => {
	const s = await setup(passGate, {
		gh: mergeAnswers("HTTP 502: Bad Gateway", "OPEN"),
	});
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toEqual({
		status: "failed",
		reason: "merge refused for PR #42: HTTP 502: Bad Gateway",
		infra: true,
	});
	expect(lastLanded(s.dir)).toBeUndefined();
	const moved = await setup(passGate, {
		gh: mergeAnswers("Head branch was modified.", "OPEN"),
	});
	await childWithCommit(moved);
	expect(await land("ACME-2", moved.ctx)).not.toHaveProperty("infra");
});

it("a land of a child whose PR is already merged records it landed once, and never rebases or gates", async () => {
	const gate = countingGate();
	const s = await setup(gate, {
		gh: (args) =>
			args[1] === "list" && args.includes("merged")
				? { stdout: JSON.stringify([{ number: 42, headRefOid: "abc" }]) }
				: gh(args),
	});
	const landed = { status: "landed", pr: 42, sha: "abc" };
	expect(await land("ACME-2", s.ctx)).toEqual(landed);
	expect(await land("ACME-2", s.ctx)).toEqual(landed);
	expect(gate.runs).toBe(0);
	expect(readRows(s.dir).rows.filter((r) => r.stage === "landed")).toEqual([
		expect.objectContaining({
			child: "ACME-2",
			data: { pr: 42, sha: "abc", source: "github", tracker: "pending" },
		}),
	]);
	expect(s.ctx.tracker.writes).toEqual([
		{
			kind: "transition",
			key: "ACME-2",
			state: s.ctx.profile.transitions.landed,
		},
	]);
	expect(
		s.ghCalls.some((a) => a[1] === "create" && a.includes("portia/ACME-2")),
	).toBe(false);
});

it("a land with mergedIn records the child landed from that PR, never rebasing or gating", async () => {
	const gate = countingGate();
	const s = await setup(gate, {
		gh: (args) =>
			args[1] === "view" && args[2] === "57"
				? {
						stdout: JSON.stringify({
							state: "MERGED",
							baseRefName: "portia/ACME-0",
							mergeCommit: { oid: "def" },
						}),
					}
				: gh(args),
	});
	const ctx = { ...s.ctx, mergedIn: 57 };
	const landed = { status: "landed", pr: 57, sha: "def" };
	expect(await land("ACME-2", ctx)).toEqual(landed);
	expect(await land("ACME-2", ctx)).toEqual(landed);
	expect(gate.runs).toBe(0);
	expect(readRows(s.dir).rows.filter((r) => r.stage === "landed")).toEqual([
		expect.objectContaining({
			child: "ACME-2",
			data: { pr: 57, sha: "def", source: "github", tracker: "pending" },
		}),
	]);
});

it("a land with mergedIn refuses a PR that is not merged into the integration branch", async () => {
	const s = await setup(countingGate(), {
		gh: (args) =>
			args[1] === "view"
				? {
						stdout: JSON.stringify({
							state: "MERGED",
							baseRefName: "main",
							mergeCommit: { oid: "def" },
						}),
					}
				: gh(args),
	});
	await expect(land("ACME-2", { ...s.ctx, mergedIn: 57 })).rejects.toThrow(
		/PR #57 is not merged into/,
	);
	expect(readRows(s.dir).rows.some((r) => r.stage === "landed")).toBe(false);
});

it("a rebase an interrupted land left behind is aborted, not parked on as a conflict", async () => {
	const s = await setup();
	await childWithCommit(s);
	await s.g(s.wt, "checkout", "-q", "-b", "elsewhere", "HEAD~1");
	writeFileSync(join(s.wt, "b.txt"), "elsewhere\n");
	await s.g(s.wt, "add", ".");
	await s.g(s.wt, "commit", "-qm", "elsewhere");
	await s.g(s.wt, "checkout", "-q", "portia/ACME-2");
	expect(
		(await realExec("git", ["rebase", "elsewhere"], { cwd: s.wt })).code,
	).not.toBe(0);
	const logged: string[] = [];
	const spy = vi
		.spyOn(console, "error")
		.mockImplementation((m: unknown) => void logged.push(String(m)));
	try {
		expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	} finally {
		spy.mockRestore();
	}
	expect(logged).toContain(
		"ACME-2: aborted a rebase an earlier land left unfinished",
	);
	expect(readFileSync(join(s.wt, "b.txt"), "utf8")).toBe("child\n");
});

it("reviews the child while CI runs, not before the CI wait starts", async () => {
	let marker = "";
	const s = await setup(passGate, {
		gh: (args) => {
			if (isPoll(args)) writeFileSync(marker, "");
			return gh(args);
		},
	});
	marker = join(s.root, "polled");
	// The review only finishes once CI has been polled: run one after the other, it times out.
	s.ctx.profile.review = {
		child: {
			cmd: `while [ ! -f ${marker} ]; do sleep 0.02; done; echo '{"findings":[]}'`,
			timeoutMs: 5_000,
			onFindings: "fail",
		},
	};
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(readRows(s.dir).rows.find((r) => r.stage === "review")).toMatchObject({
		status: "clean",
	});
});

it("a review that blocks the land stops the CI wait", async () => {
	let polls = 0;
	const s = await setup(passGate, {
		gh: (args) => {
			if (isPoll(args)) polls++;
			return args[1] === "checks"
				? checksJson([{ name: "unit", bucket: "pending" }])
				: gh(args);
		},
	});
	s.ctx.profile.review = review(
		`sleep 0.2; echo '{"findings":[{"message":"unchecked input"}]}'; exit 1`,
	);
	await childWithCommit(s);
	expect(await land("ACME-2", s.ctx)).toMatchObject({ status: "failed" });
	const seen = polls;
	expect(seen).toBeGreaterThan(0);
	await sleep(100);
	expect(polls).toBe(seen);
	expect(mergeCalls(s)).toEqual([]);
});

it("writes the landed row before the tracker call, and a tracker that hangs does not hold the land", async () => {
	const tracker = new (class extends FakeTracker {
		transition(): Promise<void> {
			return new Promise(() => {});
		}
	})();
	const s = await setup(passGate, { tracker });
	await childWithCommit(s);
	expect(
		(await land("ACME-2", { ...s.ctx, trackerTimeoutMs: 50 })).status,
	).toBe("landed");
	expect(lastLanded(s.dir)?.data).toMatchObject({
		pr: 42,
		tracker: "pending",
	});
	expect(readRows(s.dir).rows.at(-1)).toMatchObject({
		stage: "tracker",
		status: "failed",
		data: { jiraError: "the tracker did not answer within 50ms" },
	});
});

/** A second child, ACME-3, with its own worktree and a commit of its own. */
async function addChild3(s: Awaited<ReturnType<typeof setup>>) {
	const wt3 = join(s.ctx.profile.worktreesDir, s.ctx.profile.repo, "ACME-3");
	await s.g(
		s.repo,
		"worktree",
		"add",
		"-B",
		"portia/ACME-3",
		wt3,
		"origin/portia/ACME-0",
	);
	writeFileSync(
		join(s.dir, "env-ACME-3.json"),
		JSON.stringify({
			worktree: wt3,
			branch: "portia/ACME-3",
			db: "d",
			port: 2,
			envFile: "/x",
		}),
	);
	writeFileSync(join(wt3, "c.txt"), "child3\n");
	await s.g(wt3, "add", ".");
	await s.g(wt3, "commit", "-m", "child 3 work");
}

it("two children's exit gates run at the same time, and both land", async () => {
	let running = 0;
	let most = 0;
	let bothIn: () => void = () => {};
	const barrier = new Promise<void>((r) => {
		bothIn = r;
	});
	const s = await setup(async () => {
		most = Math.max(most, ++running);
		if (running === 2) bothIn();
		await Promise.race([barrier, sleep(15_000)]);
		running--;
		return { kind: "exit", ok: true, steps: [] };
	});
	await childWithCommit(s);
	await addChild3(s);
	s.ctx.lockOpts = { timeoutMs: 10_000, pollMs: 10 };
	const outs = await Promise.all([
		land("ACME-2", s.ctx),
		land("ACME-3", s.ctx),
	]);
	expect(outs.map((o) => o.status)).toEqual(["landed", "landed"]);
	expect(most).toBe(2);
	expect(mergeCalls(s)).toHaveLength(2);
});

it("the exit gate is pinned to the commit its child was rebased onto, not a tip a sibling's fetch moves", async () => {
	const seen: (string | undefined)[] = [];
	let s: Awaited<ReturnType<typeof setup>> | undefined;
	s = await setup(async (_k?: string, onto?: string) => {
		seen.push(onto);
		if (s) {
			await landElsewhere(s);
			await realGit(s.wt, "fetch", "origin", "portia/ACME-0");
		}
		return { kind: "exit", ok: true, steps: [] };
	});
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(seen).toHaveLength(1);
	expect(seen[0]).toBe((await realGit(s.wt, "rev-parse", "HEAD~1")).trim());
	expect(seen[0]).not.toBe(
		(await realGit(s.wt, "rev-parse", "origin/portia/ACME-0")).trim(),
	);
});

it("landing the same tree on the same tip again reuses the land's own passing gate", async () => {
	const gate = countingGate();
	let ciUp = false;
	const s = await setup(gate, {
		gh: ghWithChecks(() =>
			ciUp ? passing : { code: 1, stderr: "no checks reported" },
		),
	});
	const ctx = { ...s.ctx, gateInputs: () => "inputs-1" };
	await childWithCommit(s);
	expect(await land("ACME-2", ctx)).toMatchObject({
		status: "failed",
		infra: true,
	});
	ciUp = true;
	expect((await land("ACME-2", ctx)).status).toBe("landed");
	expect(gate.runs).toBe(1);
});

it("other gate inputs or a dirty worktree run the gate again", async () => {
	const gate = countingGate();
	const s = await setup(gate, {
		gh: ghWithChecks(() => ({ code: 1, stderr: "no checks reported" })),
	});
	await childWithCommit(s);
	await land("ACME-2", { ...s.ctx, gateInputs: () => "inputs-1" });
	await land("ACME-2", { ...s.ctx, gateInputs: () => "inputs-2" });
	expect(gate.runs).toBe(2);
	writeFileSync(join(s.wt, "scratch.txt"), "untracked\n");
	await land("ACME-2", { ...s.ctx, gateInputs: () => "inputs-2" });
	expect(gate.runs).toBe(3);
	await land("ACME-2", s.ctx);
	expect(gate.runs).toBe(4);
});

it("the regression guard is part of what a land's passing gate is keyed on, so a sibling landing runs it again", () => {
	const scenarioPlan = parent(
		[
			spine({
				acceptance: {
					F1: "packages/acme-web/e2e/a.e2e.ts",
					F2: "packages/acme-web/e2e/b.e2e.ts",
				},
			}),
			child("ACME-2", { requirements: ["F1"] }),
			child("ACME-3", { requirements: ["F2"] }),
		],
		[
			{ id: "F1", text: "one" },
			{ id: "F2", text: "two" },
		],
	);
	const landedA = [
		{ at: "t", child: "ACME-2", attempt: 1, stage: "landed" as const },
	];
	const inputs = (p: Profile, rows: typeof landedA) => {
		const view = landGateView(p, scenarioPlan, [], rows, "ACME-3");
		return {
			regressionGuard: view.regressionGuard,
			key: landGateInputs(p, view),
		};
	};
	const before = inputs(testProfile(), []);
	const after = inputs(testProfile(), landedA);
	expect(before.regressionGuard).toEqual([]);
	expect(after.regressionGuard).toEqual([
		{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" },
	]);
	expect(after.key).not.toBe(before.key);
	const off = { ...testProfile(), regressionGuard: false };
	expect(inputs(off, landedA)).toEqual({
		regressionGuard: [],
		key: inputs(off, []).key,
	});
});

it("a spine's land gate runs the scenario it owns, and the regression guard holds it once the spine lands", () => {
	const scenarioPlan = parent(
		[
			spine({
				requirements: ["F1"],
				acceptance: {
					F1: "packages/acme-web/e2e/a.e2e.ts",
					F2: "packages/acme-web/e2e/b.e2e.ts",
				},
			}),
			child("ACME-2", { requirements: ["F2"] }),
		],
		[
			{ id: "F1", text: "one" },
			{ id: "F2", text: "two" },
		],
	);
	const spineView = landGateView(testProfile(), scenarioPlan, [], [], "ACME-1");
	expect(spineView.owned.owned).toEqual([
		{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" },
	]);
	expect(spineView.owned.guard).toBeUndefined();
	expect(spineView.regressionGuard).toEqual([]);
	const rows = [
		{ at: "t", child: "ACME-1", attempt: 1, stage: "landed" as const },
	];
	expect(
		landGateView(testProfile(), scenarioPlan, [], rows, "ACME-2")
			.regressionGuard,
	).toEqual([{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" }]);
});

it("the regression guard counts only the siblings landed in the tip being gated, not one that landed after it was read", () => {
	const scenarioPlan = parent(
		[
			spine({ acceptance: { F1: "packages/acme-web/e2e/a.e2e.ts" } }),
			child("ACME-2", { requirements: ["F1"] }),
			child("ACME-3", { requirements: ["F2"] }),
		],
		[
			{ id: "F1", text: "one" },
			{ id: "F2", text: "two" },
		],
	);
	const rows = [
		{ at: "t", child: "ACME-2", attempt: 1, stage: "landed" as const },
	];
	const regressionGuard = (landed?: Set<string>) =>
		landGateView(testProfile(), scenarioPlan, [], rows, "ACME-3", landed)
			.regressionGuard;
	expect(regressionGuard(new Set())).toEqual([]);
	expect(regressionGuard(new Set(["ACME-2"]))).toEqual([
		{ id: "F1", path: "packages/acme-web/e2e/a.e2e.ts" },
	]);
	expect(regressionGuard()).toEqual(regressionGuard(new Set(["ACME-2"])));
});

it("a land hands its gate the children landed when its tip was read, not a sibling that lands while it gates", async () => {
	const seen: { gate?: string[]; inputs?: string[] } = {};
	const s = await setup(async (_key, _onto, landed) => {
		seen.gate = [...(landed ?? [])];
		return { kind: "exit", ok: true, steps: [] };
	});
	const { dir } = s.ctx;
	appendRow(dir, {
		child: "ACME-1",
		attempt: 1,
		stage: "landed",
		status: "landed",
	});
	await childWithCommit(s);
	await land("ACME-2", {
		...s.ctx,
		gateInputs: (_key, landed) => {
			seen.inputs = [...(landed ?? [])];
			// A sibling merges after this land read its tip, before its gate starts.
			appendRow(dir, {
				child: "ACME-3",
				attempt: 1,
				stage: "landed",
				status: "landed",
			});
			return "inputs";
		},
	});
	expect(seen.inputs).toEqual(["ACME-1"]);
	expect(seen.gate).toEqual(["ACME-1"]);
});

it("with landOnGatedTip, a tip that moves during the gate re-gates before review and CI, and merges once", async () => {
	let runs = 0;
	let s: Awaited<ReturnType<typeof setup>> | undefined;
	s = await setup(async () => {
		if (runs++ === 0 && s) await landElsewhere(s);
		return { kind: "exit", ok: true, steps: [] };
	});
	s.ctx.profile.landOnGatedTip = true;
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(runs).toBe(2);
	expect(mergeCalls(s)).toHaveLength(1);
	expect(mergeCalls(s)[0]?.at(-1)).toBe(
		(await s.g(s.wt, "rev-parse", "HEAD")).trim(),
	);
});

it("with landOnGatedTip, a re-gate after the tip moved does not review the same diff again", async () => {
	const s = await setup(countingGate());
	const heads = join(s.root, "reviewed-heads");
	s.ctx.profile.review = review(
		`echo "$PORTIA_HEAD_SHA" >> ${heads}; echo '{"findings":[]}'`,
	);
	s.ctx.profile.landOnGatedTip = true;
	await childWithCommit(s);
	afterFirstCheck(s, async () => {
		await landElsewhere(s);
	});
	const out = await land("ACME-2", s.ctx);
	expect(out.status).toBe("landed");
	expect(readFileSync(heads, "utf8").trim().split("\n")).toHaveLength(1);
	expect(readRows(s.dir).rows.filter((r) => r.stage === "review")).toHaveLength(
		1,
	);
});

it("CI or GitHub failing a land is tagged infra, and one more than MAX_RELANDS in a row parks the child", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-reland-"));
	appendRow(dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
	const infra = {
		status: "failed" as const,
		reason: "no CI checks appeared on PR #42 within 300000ms",
		infra: true as const,
	};
	for (let i = 0; i < MAX_RELANDS; i++) {
		const out = capRelands(dir, "ACME-2", infra);
		expect(out).toEqual(infra);
		recordLandFailure(dir, "ACME-2", out);
	}
	expect(readRows(dir).rows.at(-1)).toMatchObject({
		stage: "land",
		status: "failed",
		data: { infra: true },
	});
	const parked = capRelands(dir, "ACME-2", infra);
	expect(parked).toMatchObject({
		status: "parked",
		reason: expect.stringContaining(
			`CI or GitHub failed ${MAX_RELANDS + 1} landings of ACME-2 in a row`,
		),
	});
	expect(parked).not.toHaveProperty("infra");
	recordLandFailure(dir, "ACME-2", parked);
	// Once a person has looked, the count starts again.
	expect(capRelands(dir, "ACME-2", infra)).toEqual(infra);
	const ciFailed = { status: "failed" as const, reason: "CI failed on PR #42" };
	expect(capRelands(dir, "ACME-2", ciFailed)).toEqual(ciFailed);
});

const tipOf = async (s: Awaited<ReturnType<typeof setup>>) => {
	await s.g(s.wt, "fetch", "origin", "portia/ACME-0");
	return (await s.g(s.wt, "rev-parse", "origin/portia/ACME-0")).trim();
};

it("with directLand, a small epic's child is pushed onto the integration branch as one commit, with no PR or CI", async () => {
	const s = await setup();
	s.ctx.profile.directLand = { maxChildren: 4 };
	await childWithCommit(s);
	const onto = await tipOf(s);
	const before = s.ghCalls.length;
	const out = await land("ACME-2", s.ctx);
	expect(out.status).toBe("landed");
	// The draft epic PR was opened by setup; the land itself opens and merges none.
	expect(s.ghCalls.slice(before).filter((a) => a[0] === "pr")).toEqual([]);
	const gated = (await s.g(s.wt, "rev-parse", "HEAD")).trim();
	const tip = await tipOf(s);
	expect((await s.g(s.wt, "rev-parse", `${tip}^`)).trim()).toBe(onto);
	expect((await s.g(s.wt, "rev-parse", `${tip}^{tree}`)).trim()).toBe(
		(await s.g(s.wt, "rev-parse", `${gated}^{tree}`)).trim(),
	);
	const message = await s.g(s.wt, "log", "-1", "--format=%B", tip);
	expect(message).toContain(`${prTitle(plan, child2)} [ACME-2]`);
	expect(message).toContain("Portia-Child: ACME-2");
	expect(lastLanded(s.dir)).toMatchObject({
		child: "ACME-2",
		data: { sha: tip, gated, onto, direct: true },
	});
	expect(lastLanded(s.dir)?.data?.pr).toBeUndefined();
	expect(s.ctx.tracker.writes).toEqual([
		{
			kind: "transition",
			key: "ACME-2",
			state: s.ctx.profile.transitions.landed,
		},
	]);
});

it("with directLand, a child whose head adds a secret never reaches the integration branch", async () => {
	const s = await setup();
	s.ctx.profile.directLand = { maxChildren: 4 };
	const key = `sk${"_live_"}Q3tZ7rKx2M5vB8nWp4Ls9Hd6`;
	writeFileSync(join(s.wt, "pay.ts"), `const k = "${key}";\n`);
	await s.g(s.wt, "add", ".");
	await s.g(s.wt, "commit", "-m", "child work");
	const onto = await tipOf(s);
	const out = await land("ACME-2", s.ctx);
	expect(out).toMatchObject({
		status: "failed",
		reason: expect.stringContaining("secret stripe-live-key: pay.ts:1"),
	});
	expect(JSON.stringify(out)).not.toContain(key);
	expect(await tipOf(s)).toBe(onto);
});

it("with directLand, a child already pushed when its land died is recorded landed, not pushed again", async () => {
	const s = await setup();
	s.ctx.profile.directLand = { maxChildren: 4 };
	await childWithCommit(s);
	await land("ACME-2", s.ctx);
	const tip = await tipOf(s);
	// The land died after the push, before its landed row.
	const file = join(s.dir, "runlog.jsonl");
	writeFileSync(
		file,
		readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l && !l.includes('"landed"') && !l.includes('"tracker"'))
			.map((l) => `${l}\n`)
			.join(""),
	);
	expect(lastLanded(s.dir)).toBeUndefined();
	const again = await land("ACME-2", s.ctx);
	expect(again.status).toBe("landed");
	expect(await tipOf(s)).toBe(tip);
	expect(lastLanded(s.dir)).toMatchObject({
		data: { sha: tip, direct: true, source: "push" },
	});
});

it("with directLand, an epic of more children than maxChildren lands through a PR as before", async () => {
	const s = await setup();
	s.ctx.profile.directLand = { maxChildren: 2 };
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(s.ghCalls.some((a) => a[1] === "merge")).toBe(true);
	expect(lastLanded(s.dir)).toMatchObject({ data: { pr: 42 } });
});

it("with directLand, a tip that moves while the child gates is gated again and the child lands on it", async () => {
	let gates = 0;
	let s: Awaited<ReturnType<typeof setup>> | undefined;
	s = await setup(async () => {
		gates++;
		if (gates === 1 && s) {
			// A sibling lands on the integration branch while this child gates.
			const other = join(s.root, "other");
			await s.g(s.repo, "worktree", "add", other, "origin/portia/ACME-0");
			writeFileSync(join(other, "c.txt"), "sibling\n");
			await s.g(other, "add", ".");
			await s.g(other, "commit", "-m", "sibling");
			await s.g(other, "push", "origin", "HEAD:refs/heads/portia/ACME-0");
		}
		return passGate();
	});
	s.ctx.profile.directLand = { maxChildren: 4 };
	await childWithCommit(s);
	expect((await land("ACME-2", s.ctx)).status).toBe("landed");
	expect(gates).toBe(2);
	const tip = await tipOf(s);
	expect(await s.g(s.wt, "show", `${tip}:c.txt`)).toBe("sibling\n");
	expect(await s.g(s.wt, "show", `${tip}:b.txt`)).toBe("child\n");
});
