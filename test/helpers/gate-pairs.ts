import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { childBranch, integrationBranch } from "../../src/core/branches";
import { type Profile, testProfile } from "../../src/core/config";
import { realExec } from "../../src/core/exec";
import { readRows } from "../../src/core/runlog";
import type { ParentPlan } from "../../src/core/types";
import type { GateReport } from "../../src/gate/run";
import {
	initIntegration,
	type LandCtx,
	type LandOutcome,
	land,
} from "../../src/land/integration-and-land";
import { localGitHub } from "../e2e/local-github";
import { FakeTracker } from "../support/fake-tracker";
import { sandbox } from "./git-sandbox";
import { child, parent, spine } from "./plan";
/**
 * A pair is a directory under test/fixtures/gate-pairs holding `base/` (the tree both
 * children start from), `a/` and `b/` (each child's files, laid over the base) and
 * `pair.json`: `{ "breaks": boolean, "check": "<shell command, run at the tree's root>" }`.
 */
export interface Pair {
	name: string;
	dir: string;
	breaks: boolean;
	check: string;
}

export const PAIRS = join(import.meta.dirname, "../fixtures/gate-pairs");

export function pairs(): Pair[] {
	if (!existsSync(PAIRS)) return [];
	return readdirSync(PAIRS)
		.filter((n) => existsSync(join(PAIRS, n, "pair.json")))
		.map((name) => {
			const dir = join(PAIRS, name);
			const p = JSON.parse(readFileSync(join(dir, "pair.json"), "utf8"));
			return { name, dir, breaks: p.breaks === true, check: String(p.check) };
		});
}

export const check = async (pair: Pair, cwd: string) => {
	const r = await realExec("sh", ["-c", pair.check], { cwd });
	return { ok: r.code === 0, tail: `${r.stdout}\n${r.stderr}`.trim() };
};

/** What a pair's landings run as the exit gate; by default the pair's own check of the whole tree. */
export type PairGate = (run: {
	plan: ParentPlan;
	profile: Profile;
	dir: string;
}) => LandCtx["gate"];

/** Lands child a, then child b, through the real land() against a local integration branch. */
export async function landPair(
	pair: Pair,
	o: { plan?: ParentPlan; profile?: Partial<Profile>; gate?: PairGate } = {},
) {
	const s = await sandbox();
	cpSync(join(pair.dir, "base"), s.repo, { recursive: true });
	await s.g(s.repo, "add", ".");
	await s.g(s.repo, "commit", "-q", "-m", "base");
	await s.g(s.repo, "push", "-q", "origin", "HEAD:main");

	const plan = o.plan ?? parent([spine(), child("ACME-2"), child("ACME-3")]);
	const profile = {
		...testProfile(),
		repo: "acme-web",
		worktreesDir: join(s.root, "wt"),
		...o.profile,
	};
	const dir = mkdtempSync(join(s.root, "run-"));
	const github = localGitHub(join(s.root, "origin.git"), s.root, realExec);
	const trees: Record<string, string> = {};
	const ctx = {
		exec: github.exec,
		profile,
		repoRoot: s.repo,
		dir,
		plan,
		tracker: new FakeTracker()
			.add({ key: "ACME-2", summary: "a", description: "", blockedBy: [] })
			.add({ key: "ACME-3", summary: "b", description: "", blockedBy: [] }),
		gate:
			o.gate?.({ plan, profile, dir }) ??
			(async (key: string): Promise<GateReport> => {
				const r = await check(pair, trees[key] as string);
				return { kind: "exit", ok: r.ok, steps: [{ name: "check", ...r }] };
			}),
		lockOpts: { timeoutMs: 5_000, pollMs: 10 },
		checksPollMs: 5,
		checksWaitMs: 1_000,
	};
	await initIntegration(ctx);
	const base = integrationBranch(profile, plan.key);
	for (const [key, side] of [
		["ACME-2", "a"],
		["ACME-3", "b"],
	] as const) {
		const wt = join(profile.worktreesDir, profile.repo, key);
		const branch = childBranch(profile, key);
		await s.g(
			s.repo,
			"worktree",
			"add",
			"-q",
			"-B",
			branch,
			wt,
			`origin/${base}`,
		);
		cpSync(join(pair.dir, side), wt, { recursive: true });
		await s.g(wt, "add", ".");
		await s.g(wt, "commit", "-q", "-m", `${key} work`);
		expect(
			await check(pair, wt),
			`${pair.name}: ${side} passes alone`,
		).toMatchObject({ ok: true });
		trees[key] = wt;
		writeFileSync(
			join(dir, `env-${key}.json`),
			JSON.stringify({ worktree: wt, branch, db: "", port: 1, envFile: "/x" }),
		);
	}
	const a: LandOutcome = await land("ACME-2", ctx);
	const b: LandOutcome = await land("ACME-3", ctx);
	const tip = join(s.root, "integration-tip");
	await s.g(s.repo, "fetch", "-q", "origin");
	await s.g(s.repo, "worktree", "add", "-q", "--detach", tip, `origin/${base}`);
	const landed = readRows(dir)
		.rows.filter((r) => r.stage === "landed")
		.map((r) => r.child);
	const merged = github.prs
		.filter((p) => p.state === "merged")
		.map((p) => p.head);
	return {
		a,
		b,
		landed,
		merged,
		branchB: childBranch(profile, "ACME-3"),
		integration: await check(pair, tip),
	};
}
