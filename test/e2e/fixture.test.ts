import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import {
	type Exec,
	must,
	realExec,
	spawnExec,
	useSpawner,
} from "../../src/core/exec";
import type { FakeTracker } from "../support/fake-tracker";
import { localGitHub } from "./local-github";
import { recordedTracker } from "./recorded-tracker";
import { scriptedWorker } from "./scripted-worker";

/**
 * Portia's whole command path on a repository with no Acme profile: check, integration
 * init, status, env up, dispatch, brief, a scripted worker, result, land, a kill, resume,
 * ledger and epic. Local mode (the default) uses a FakeTracker and a bare repo as origin,
 * with `gh pr` emulated. PORTIA_E2E_LIVE=1 runs the same path against GitHub Issues and
 * PRs on mousedown/portia-fixture, and cleans up the branches and PRs it opened.
 */
const LIVE = process.env.PORTIA_E2E_LIVE === "1";
const REPO = "mousedown/portia-fixture";
const PARENT = "GH-1";
const SPINE = "GH-2";
const WAVE1 = ["GH-3", "GH-4"];
const CHILDREN = [SPINE, ...WAVE1];
const FIXTURE = join(import.meta.dirname, "fixture-repo");

const root = mkdtempSync(join(tmpdir(), "portia-e2e-"));
const repo = join(root, "repo");
const resultsDir = join(root, "results");
const saved = {
	cwd: process.cwd(),
	env: {
		PORTIA_HOME: process.env.PORTIA_HOME,
		PORTIA_WORKTREES: process.env.PORTIA_WORKTREES,
		PORTIA_PROFILE: process.env.PORTIA_PROFILE,
		PORTIA_DRY_RUN: process.env.PORTIA_DRY_RUN,
	},
};
const restores: (() => void)[] = [];
let tracker: FakeTracker | undefined;
let local: ReturnType<typeof localGitHub> | undefined;

const git = async (cwd: string, ...args: string[]) =>
	(await must(spawnExec, "git", args, { cwd })).trim();
const gh = async (...args: string[]) =>
	(await must(spawnExec, "gh", args)).trim();

/** The next successful `gh pr merge` throws after merging: the process dies before it logs. */
let killAfterMerge = false;
const killable =
	(inner: Exec): Exec =>
	async (cmd, args, opts) => {
		const r = await inner(cmd, args, opts);
		if (killAfterMerge && cmd === "gh" && args[1] === "merge" && !r.code) {
			killAfterMerge = false;
			throw new Error("simulated kill: the process died after the merge");
		}
		return r;
	};

async function portia(...argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		out: (s) => out.push(s),
		err: (s) => err.push(s),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}
async function ok(...argv: string[]): Promise<string> {
	const r = await portia(...argv);
	expect(r.code, `portia ${argv.join(" ")}\n${r.out}\n${r.err}`).toBe(0);
	return r.out;
}
const status = async () => {
	const r = await portia("status", PARENT, "--json");
	return {
		code: r.code,
		...(JSON.parse(r.out) as {
			states: Record<string, string>;
			ready: string[];
		}),
	};
};

/** Live mode: close Portia's open PRs, delete its branches, labels and comments. */
async function cleanLive() {
	const open = JSON.parse(
		await gh(
			"pr",
			"list",
			"-R",
			REPO,
			"--state",
			"open",
			"--json",
			"number,headRefName",
		),
	) as { number: number; headRefName: string }[];
	for (const p of open.filter((x) => x.headRefName.startsWith("portia/")))
		await gh("pr", "close", String(p.number), "-R", REPO);
	const refs = JSON.parse(
		await gh("api", `repos/${REPO}/git/matching-refs/heads/portia/`),
	) as { ref: string }[];
	for (const r of refs)
		await gh("api", "-X", "DELETE", `repos/${REPO}/git/${r.ref}`);
	for (const key of CHILDREN) {
		const n = key.slice(3);
		const labels = JSON.parse(
			await gh("api", `repos/${REPO}/issues/${n}/labels`),
		) as { name: string }[];
		for (const l of labels.filter((x) => x.name.startsWith("portia:")))
			await gh(
				"api",
				"-X",
				"DELETE",
				`repos/${REPO}/issues/${n}/labels/${encodeURIComponent(l.name)}`,
			);
		const comments = JSON.parse(
			await gh(
				"api",
				`repos/${REPO}/issues/${n}/comments`,
				"--paginate",
				"--slurp",
			),
		) as { id: number; body: string }[][];
		for (const c of comments
			.flat()
			.filter((x) => x.body.startsWith("Portia, attempt")))
			await gh("api", "-X", "DELETE", `repos/${REPO}/issues/comments/${c.id}`);
	}
}

beforeAll(
	async () => {
		process.env.PORTIA_HOME = join(root, "home");
		process.env.PORTIA_WORKTREES = join(root, "wt");
		delete process.env.PORTIA_PROFILE;
		delete process.env.PORTIA_DRY_RUN;
		mkdirSync(resultsDir);
		if (LIVE) {
			await cleanLive();
			await git(root, "clone", "-q", `https://github.com/${REPO}.git`, repo);
			restores.push(useSpawner(killable(spawnExec)));
		} else {
			const origin = join(root, "origin.git");
			await git(root, "init", "-q", "--bare", "-b", "main", origin);
			await git(root, "clone", "-q", origin, repo);
			cpSync(FIXTURE, repo, { recursive: true });
			await git(repo, "add", "-A");
			await git(
				repo,
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.com",
				"commit",
				"-q",
				"-m",
				"A tiny bun project",
			);
			await git(repo, "push", "-q", "origin", "HEAD:main");
			local = localGitHub(origin, root, spawnExec);
			tracker = recordedTracker();
			restores.push(useSpawner(killable(local.exec)));
			restores.push(useTracker(tracker));
		}
		// Worktrees share this config, so the scripted worker can commit.
		await git(repo, "config", "user.email", "fixture-e2e@example.com");
		await git(repo, "config", "user.name", "Fixture e2e");
		process.chdir(repo);
	},
	LIVE ? 120_000 : undefined,
);

afterAll(async () => {
	process.chdir(saved.cwd);
	for (const r of restores.reverse()) r();
	for (const [k, v] of Object.entries(saved.env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		if (LIVE) await cleanLive();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);

/** env up, dispatch, brief, the scripted worker, result: the child ends done, not landed. */
async function work(key: string) {
	const env = JSON.parse(await ok("env", "up", key, "--parent", PARENT)) as {
		worktree: string;
	};
	const d = JSON.parse(await ok("dispatch", key, "--parent", PARENT));
	expect(d).toMatchObject({ child: key, attempt: 1 });
	expect(await ok("brief", key, "--parent", PARENT)).toContain(key);
	const file = await scriptedWorker(
		spawnExec,
		key,
		env.worktree,
		join(resultsDir, `${key}.json`),
	);
	const applied = JSON.parse(
		await ok(
			"result",
			key,
			"--parent",
			PARENT,
			"--from",
			file,
			"--tokens",
			"1000",
		),
	);
	expect(applied).toMatchObject({ status: "done", outside: [] });
}

it(
	"runs a three-child plan end to end on a repo with no Acme profile",
	async () => {
		expect(await ok("check", PARENT)).toContain(
			"ok: the plan passes portia check",
		);
		const { epicPr } = JSON.parse(await ok("integration", "init", PARENT)) as {
			epicPr: number;
		};
		await ok("env", "template", PARENT);

		// Wave barrier: only the spine is ready, and A and B stay pending until it lands.
		let s = await status();
		expect(s).toMatchObject({ code: 0, ready: [SPINE] });
		for (const k of WAVE1) expect(s.states[k]).toBe("pending");

		await work(SPINE);
		s = await status();
		expect(s).toMatchObject({ code: 10, ready: [] });
		expect(s.states[SPINE]).toBe("done");
		for (const k of WAVE1) expect(s.states[k]).toBe("pending");

		expect(
			JSON.parse(await ok("land", SPINE, "--parent", PARENT)),
		).toMatchObject({
			status: "landed",
		});
		await ok("integration", "sync", PARENT);
		s = await status();
		expect(s).toMatchObject({ code: 0, ready: WAVE1 });

		// Wave 1: A lands; the process is killed between B's merge and its run-log row.
		for (const k of WAVE1) await work(k);
		const [a, b] = WAVE1 as [string, string];
		expect(JSON.parse(await ok("land", a, "--parent", PARENT))).toMatchObject({
			status: "landed",
		});
		killAfterMerge = true;
		const killed = await portia("land", b, "--parent", PARENT);
		expect(killed.code).toBe(11);
		expect(killed.err).toContain("simulated kill");
		expect((await status()).states[b]).toBe("done");

		// Resume reads the merge from GitHub and records the landing the kill lost.
		const resumed = await portia("resume", PARENT);
		expect(resumed.code, resumed.err).toBe(0);
		expect(JSON.parse(resumed.out.split("\n")[0] ?? "")).toMatchObject({
			actions: [{ child: b, action: "record-landed" }],
			problems: [],
		});
		expect((await portia("resume", PARENT)).code).toBe(10);

		// The ledger lists three landed children, each with its PR.
		const ledger = await ok("ledger", PARENT, "--print");
		for (const k of CHILDREN)
			expect(ledger).toMatch(
				new RegExp(`\\| ${k} [^|]+ \\| landed \\| #\\d+ \\|`),
			);

		// The epic gate passes, marks the epic PR ready and publishes the ledger into it.
		expect(JSON.parse(await ok("epic", PARENT))).toMatchObject({ ok: true });
		// realExec reaches GitHub, or its local stand-in, as Portia does.
		const body = await must(realExec, "gh", [
			"pr",
			"view",
			String(epicPr),
			"--json",
			"body",
			"-q",
			".body",
		]);
		expect(body.match(/\| landed \| #\d+ \|/g)).toHaveLength(3);

		// The integration branch ends with three squash commits, one per child, in wave order.
		await git(repo, "fetch", "-q", "origin");
		const log = (
			await git(
				repo,
				"log",
				"--format=%P%x09%s",
				`origin/main..origin/epic/${PARENT}`,
			)
		)
			.split("\n")
			.map((l) => l.split("\t") as [string, string]);
		const squashes = log.slice(0, 3).reverse();
		expect(
			squashes.map(([, subject]) => subject.match(/GH-[234]/)?.[0]),
		).toEqual(CHILDREN);
		for (const [parents, subject] of squashes) {
			expect(parents.split(" ")).toHaveLength(1);
			expect(subject).toMatch(/\(#\d+\)$/);
		}
		expect(log).toHaveLength(4);
		expect(log[3]?.[1]).toBe(
			`chore(fixture): ${PARENT} open the integration branch`,
		);

		if (tracker) {
			const landed = tracker.writes.flatMap((w) =>
				w.kind === "transition" && w.state === "landed" ? [w.key] : [],
			);
			expect(landed.sort()).toEqual(CHILDREN);
			expect(local?.prs.find((p) => p.number === epicPr)?.draft).toBe(false);
		}

		// Nothing Portia wrote outward names it: branches, PR titles and bodies, the
		// commit messages and identities on origin, and tracker comments and labels.
		if (tracker && local) {
			const branches = await git(repo, "ls-remote", "--heads", "origin");
			expect(branches).toContain(`refs/heads/epic/${PARENT}`);
			const commits = await git(
				repo,
				"log",
				"--all",
				"--format=%an%n%ae%n%cn%n%ce%n%B",
			);
			const outward = [
				branches,
				commits,
				...local.prs.flatMap((p) => [p.head, p.base, p.title, p.body]),
				...tracker.writes.map((w) => JSON.stringify(w)),
			];
			expect(local.prs.length).toBeGreaterThan(0);
			expect(
				tracker.writes.some((w) => w.kind === "comment"),
				"the run wrote tracker comments",
			).toBe(true);
			for (const text of outward) expect(text).not.toMatch(/portia/i);
		}
	},
	LIVE ? 30 * 60_000 : 60_000,
);
