import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { type Exec, must, spawnExec, useSpawner } from "../../src/core/exec";
import { runPath } from "../../src/core/rundir";
import { readRows } from "../../src/core/runlog";
import type { RunRow } from "../../src/core/types";
import type { DriveResult } from "../../src/drive/types";
import { localGitHub } from "../e2e/local-github";
import { recordedTracker } from "../e2e/recorded-tracker";
import type { FakeTracker } from "../support/fake-tracker";

/**
 * A planned run of the fixture repository (`test/e2e/fixture-repo`): parent GH-1, spine
 * GH-2 in wave 0, GH-3 and GH-4 in wave 1. GitHub is a bare repo with `gh pr` emulated,
 * the tracker holds the recorded fixture issues, and each worker is a real detached
 * process running `drive-worker.ts` in place of the model.
 */
export const PARENT = "GH-1";
export const SPINE = "GH-2";
export const WAVE1 = ["GH-3", "GH-4"] as const;
export const CHILDREN = [SPINE, ...WAVE1];

const FIXTURE = join(import.meta.dirname, "../e2e/fixture-repo");
const WORKER = join(import.meta.dirname, "drive-worker.ts");
const ENV = [
	"PORTIA_HOME",
	"PORTIA_WORKTREES",
	"PORTIA_PROFILE",
	"PORTIA_DRY_RUN",
	"PORTIA_EVAL_ANSWERS",
	"DRIVE_PARK",
	"DRIVE_PARK_ALWAYS",
	"DRIVE_TOKENS",
	"DRIVE_SEEN",
	"DRIVE_SPEC_ROUTE",
	"DRIVE_SPEC_CLAIM",
] as const;

export interface DriveRun {
	root: string;
	repo: string;
	tracker: FakeTracker;
	prs: ReturnType<typeof localGitHub>["prs"];
	/** Any Portia command, in process, as the orchestrator runs it. */
	portia(
		...argv: string[]
	): Promise<{ code: number; out: string; err: string }>;
	/** `portia drive <PARENT> --json [extra]`, with its JSON parsed when it printed any. */
	drive(
		...extra: string[]
	): Promise<{ code: number; result?: DriveResult; err: string }>;
	rows(): RunRow[];
	/** Each worker that ran, in order: its child and the files under src/ it found. */
	seen(): string[];
	/** Rows of one stage for one child. */
	count(child: string, stage: RunRow["stage"]): number;
	/** The next `gh pr merge` of this child's PR merges, then the process dies before it logs. */
	killAfterMerge(child: string): void;
	/** Writes PORTIA_EVAL_ANSWERS for the drives that follow. */
	answers(script: Record<string, unknown>): void;
	/** Records the person's yes to the plan, as `portia signoff plan` does after the table. */
	approvePlan(): Promise<void>;
	done(): Promise<void>;
}

/**
 * Sets up the run: the fixture repo pushed to its origin, the profile with detached workers
 * (unless `workers` says otherwise), the integration branch and env template made.
 */
export async function driveRun(
	o: {
		workers?: "detached" | "subagent";
		park?: string[];
		/** Children whose worker parks on every attempt, answered or not. */
		parkAlways?: string[];
		/** A route the spine's spec requests, as in a spec reaching another child's work. */
		specRoute?: string;
		/** Tokens each named child's worker reports spending, per attempt. */
		tokens?: Record<string, number>;
		/** Children whose worker claims its spec cannot pass until the spec is amended. */
		specClaim?: string[];
	} = {},
): Promise<DriveRun> {
	const root = mkdtempSync(join(tmpdir(), "portia-drive-"));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	const saved = {
		cwd: process.cwd(),
		env: Object.fromEntries(ENV.map((k) => [k, process.env[k]])),
	};
	const restores: (() => void)[] = [];
	const git = async (cwd: string, ...args: string[]) =>
		(await must(spawnExec, "git", args, { cwd })).trim();

	await git(root, "init", "-q", "--bare", "-b", "main", origin);
	await git(root, "clone", "-q", origin, repo);
	cpSync(FIXTURE, repo, { recursive: true });
	const config = join(repo, "portia.config.ts");
	if ((o.workers ?? "detached") === "detached")
		writeFileSync(
			config,
			readFileSync(config, "utf8").replace(
				"export default {",
				`export default {\n\tworkers: { mode: "detached" as const, command: "bun", args: [${JSON.stringify(WORKER)}] },`,
			),
		);
	await git(repo, "config", "user.email", "fixture-drive@example.com");
	await git(repo, "config", "user.name", "Fixture drive");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "A tiny bun project");
	await git(repo, "push", "-q", "origin", "HEAD:main");

	const home = join(root, "home");
	process.env.PORTIA_HOME = home;
	process.env.PORTIA_WORKTREES = join(root, "wt");
	for (const k of ENV.slice(2)) delete process.env[k];
	if (o.park?.length) process.env.DRIVE_PARK = o.park.join(",");
	if (o.parkAlways?.length)
		process.env.DRIVE_PARK_ALWAYS = o.parkAlways.join(",");
	if (o.specRoute) process.env.DRIVE_SPEC_ROUTE = o.specRoute;
	if (o.specClaim?.length) process.env.DRIVE_SPEC_CLAIM = o.specClaim.join(",");
	process.env.DRIVE_SEEN = join(root, "seen.txt");
	if (o.tokens) process.env.DRIVE_TOKENS = JSON.stringify(o.tokens);

	const local = localGitHub(origin, root, spawnExec);
	let killHead: string | undefined;
	const killable: Exec = async (cmd, args, opts) => {
		const pr =
			cmd === "gh" && args[1] === "merge"
				? local.prs.find((p) => p.number === Number(args[2]))
				: undefined;
		const r = await local.exec(cmd, args, opts);
		if (pr && killHead && pr.head.endsWith(`/${killHead}`) && !r.code) {
			killHead = undefined;
			throw new Error("simulated kill: the process died after the merge");
		}
		return r;
	};
	const tracker = recordedTracker();
	restores.push(useSpawner(killable), useTracker(tracker));
	process.chdir(repo);

	const portia = async (...argv: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await runCli(argv, {
			out: (s) => out.push(s),
			err: (s) => err.push(s),
		});
		return { code, out: out.join("\n"), err: err.join("\n") };
	};
	const ok = async (...argv: string[]) => {
		const r = await portia(...argv);
		if (r.code !== 0)
			throw new Error(
				`portia ${argv.join(" ")} exited ${r.code}\n${r.out}\n${r.err}`,
			);
		return r.out;
	};
	await ok("integration", "init", PARENT);
	await ok("env", "template", PARENT);

	const rows = () => readRows(runPath(PARENT)).rows;
	return {
		root,
		repo,
		tracker,
		prs: local.prs,
		portia,
		async drive(...extra) {
			const r = await portia("drive", PARENT, "--json", ...extra);
			let result: DriveResult | undefined;
			try {
				result = JSON.parse(r.out) as DriveResult;
			} catch {}
			return { code: r.code, result, err: r.err };
		},
		rows,
		seen: () => {
			try {
				return readFileSync(join(root, "seen.txt"), "utf8")
					.split("\n")
					.filter(Boolean);
			} catch {
				return [];
			}
		},
		count: (child, stage) =>
			rows().filter((r) => r.child === child && r.stage === stage).length,
		killAfterMerge(child) {
			killHead = child;
		},
		answers(script) {
			const file = join(root, "answers.json");
			writeFileSync(file, JSON.stringify(script));
			process.env.PORTIA_EVAL_ANSWERS = file;
		},
		async approvePlan() {
			const file = join(root, "plan.md");
			writeFileSync(file, `${PARENT}: ${CHILDREN.join(", ")}\n`);
			await ok("signoff", "plan", PARENT, "--from", file);
		},
		async done() {
			process.chdir(saved.cwd);
			for (const r of restores.reverse()) r();
			for (const [k, v] of Object.entries(saved.env)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The children whose landed rows the run log holds, in the order they landed. */
export const landedOrder = (rows: RunRow[]) =>
	rows.filter((r) => r.stage === "landed").map((r) => r.child);
