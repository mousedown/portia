import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useTracker } from "../../src/cli/context";
import { runCli } from "../../src/cli/main";
import { must, spawnExec, useSpawner } from "../../src/core/exec";
import { runDir } from "../../src/core/rundir";
import { readRows } from "../../src/core/runlog";
import { useProbes } from "../../src/env/slots";
import { readWorker, realProcs } from "../../src/worker/detached";
import { FakeTracker } from "../support/fake-tracker";

/**
 * Detached workers through the real commands: a scripted process stands in for the
 * headless model. WORKER_MODE picks what it does: done (commits and writes its result),
 * silent (exits with no result) or hang (stays alive and quiet).
 */
const FIXTURE = join(import.meta.dirname, "../fixtures/profile.ts");
const PARENT = "ACME-187";
const SPINE = "ACME-201";
const SCRIPT = `
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
let brief = "";
process.stdin.on("data", (d) => { brief += d; });
process.stdin.on("end", () => {
	console.log(JSON.stringify({ type: "system", args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR }));
	const mode = process.env.WORKER_MODE;
	if (mode === "limit") return void console.log(JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit · resets 3pm (UTC)" }));
	if (mode === "hang") return void setTimeout(() => {}, 120_000);
	if (mode === "silent") return;
	const child = /You are a worker for ([A-Z0-9]+-\\d+)/.exec(brief)[1];
	const file = /write the same object to \`([^\`]+)\`/.exec(brief)[1];
	mkdirSync("packages/acme-web/src/lib", { recursive: true });
	writeFileSync("packages/acme-web/src/lib/x.ts", "export const x = 1;\\n");
	execSync("git add -A && git commit -q -m work");
	const head = execSync("git rev-parse HEAD").toString().trim();
	writeFileSync(file, JSON.stringify({ child, status: "done", head, gates: { task: "pass", exit: "pass" }, evidence: { F1: "ok" } }));
	console.log(JSON.stringify({ type: "result", usage: { input_tokens: 7, output_tokens: 3 } }));
});
`;

const saved = {
	cwd: process.cwd(),
	profile: process.env.PORTIA_PROFILE,
	home: process.env.PORTIA_HOME,
	mode: process.env.WORKER_MODE,
};
const restores: (() => void)[] = [];
let root: string;
let tracker: FakeTracker;
let profiles = 0;

const fenced = (b: string) => `\`\`\`plan\n${b}\n\`\`\``;

/** A profile file: the fixture profile, detached unless `workers` is null. */
function useProfile(
	workers: Record<string, unknown> | null,
	extra: Record<string, unknown> = {},
) {
	const file = join(root, `profile-${++profiles}.ts`);
	writeFileSync(
		file,
		`import base from ${JSON.stringify(FIXTURE)};\nexport default { ...base, ...${JSON.stringify(extra)}, worktreesDir: ${JSON.stringify(join(root, "wt"))}${workers ? `, workers: ${JSON.stringify(workers)}` : ""} };\n`,
	);
	process.env.PORTIA_PROFILE = file;
}
const detached = (stallMin = 20, extra: Record<string, unknown> = {}) =>
	useProfile(
		{
			mode: "detached",
			command: process.execPath,
			args: [join(root, "worker.mjs")],
			stallMin,
		},
		extra,
	);

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "portia-detached-"));
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	const git = (cwd: string, ...args: string[]) =>
		must(spawnExec, "git", args, { cwd });
	await git(root, "init", "-q", "--bare", "-b", "main", origin);
	await git(root, "clone", "-q", origin, repo);
	await git(repo, "config", "user.email", "t@example.com");
	await git(repo, "config", "user.name", "Test");
	mkdirSync(join(repo, "packages/acme-web"), { recursive: true });
	writeFileSync(join(repo, "packages/acme-web/package.json"), "{}\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-q", "-m", "init");
	await git(repo, "push", "-q", "origin", "HEAD:main", `HEAD:epic/${PARENT}`);
	const wt = join(root, "wt", "acme-web", SPINE);
	await git(
		repo,
		"worktree",
		"add",
		"-q",
		"-b",
		`epic/${SPINE}`,
		wt,
		`origin/epic/${PARENT}`,
	);
	writeFileSync(join(root, "worker.mjs"), SCRIPT);
	process.chdir(repo);
	process.env.PORTIA_HOME = join(root, "home");
	writeFileSync(
		join(runDir(PARENT), `env-${SPINE}.json`),
		JSON.stringify({
			worktree: wt,
			branch: `epic/${SPINE}`,
			db: "d",
			port: 3101,
			envFile: join(wt, "packages/acme-web/.env.portia"),
		}),
	);
	tracker = new FakeTracker()
		.add({
			key: PARENT,
			summary: "Epic",
			description: fenced("scope: onboarding\nscenario: F1 = Given x, Then y"),
			blockedBy: [],
		})
		.add(
			{
				key: SPINE,
				summary: "Spine",
				description: fenced(
					"wave: 0\ntouches: src/lib/**\nevidence: bun test lib\nacceptance: F1 = specs-it/acceptance/a.it.ts\nsize: S",
				),
				blockedBy: [],
			},
			PARENT,
		);
	restores.push(useTracker(tracker));
	// resume asks GitHub for merged PRs: none.
	restores.push(
		useSpawner(async (cmd, args, opts) =>
			cmd === "gh"
				? { code: 0, stdout: "[]", stderr: "" }
				: spawnExec(cmd, args, opts),
		),
	);
});

afterEach(() => {
	const rec = readWorker(runDir(PARENT), SPINE, readRows(runDir(PARENT)).rows);
	if (rec && realProcs.alive(rec.pid)) realProcs.stop(rec.pid);
	while (restores.length) restores.pop()?.();
	process.chdir(saved.cwd);
	for (const [k, v] of [
		["PORTIA_PROFILE", saved.profile],
		["PORTIA_HOME", saved.home],
		["WORKER_MODE", saved.mode],
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
const json = async (...argv: string[]) => {
	const r = await portia(...argv);
	return {
		code: r.code,
		err: r.err,
		...JSON.parse(r.out.split("\n")[0] ?? ""),
	};
};

/** dispatch, then start the scripted worker in `mode`; returns its pid. */
async function start(
	mode: "done" | "silent" | "hang" | "limit",
): Promise<number> {
	process.env.WORKER_MODE = mode;
	const d = await json("dispatch", SPINE, "--parent", PARENT);
	expect(d).toMatchObject({ code: 0, child: SPINE, worker: "detached" });
	const s = await json("worker", "start", SPINE, "--parent", PARENT);
	expect(s, s.err).toMatchObject({ code: 0, child: SPINE, attempt: d.attempt });
	return s.pid;
}
const exited = async (pid: number) => {
	for (let i = 0; i < 200 && realProcs.alive(pid); i++)
		await new Promise((r) => setTimeout(r, 25));
	expect(realProcs.alive(pid)).toBe(false);
};
const lastResult = () =>
	readRows(runDir(PARENT))
		.rows.filter((r) => r.stage === "result")
		.at(-1);

it("without workers.mode detached nothing changes: dispatch says nothing of it, and portia worker refuses", async () => {
	useProfile(null);
	const d = await json("dispatch", SPINE, "--parent", PARENT);
	expect(Object.keys(d).sort()).toEqual([
		"attempt",
		"child",
		"code",
		"err",
		"model",
	]);
	const r = await portia("worker", "start", SPINE, "--parent", PARENT);
	expect(r.code).toBe(11);
	expect(r.err).toContain('workers.mode "detached"');
	const s = await json("status", PARENT, "--json");
	expect(s.workers).toBeUndefined();
});

it("a detached worker runs headless, and portia worker wait applies its result with the log's tokens", async () => {
	detached();
	await start("done");
	const w = await json(
		"worker",
		"wait",
		SPINE,
		"--parent",
		PARENT,
		"--poll",
		"0.05",
	);
	expect(w, w.err).toMatchObject({ code: 0, status: "done", outside: [] });
	expect(lastResult()).toMatchObject({
		child: SPINE,
		status: "done",
		tokens: 10,
	});
	const log = readFileSync(
		readWorker(runDir(PARENT), SPINE, readRows(runDir(PARENT)).rows)?.log ?? "",
		"utf8",
	);
	expect(JSON.parse(log.split("\n")[0] ?? "").args).toEqual([
		"--settings",
		join(runDir(PARENT), `worker-${SPINE}-1.settings.json`),
		"--add-dir",
		runDir(PARENT),
		"--tools",
		"Bash,Read,Edit,Write,Grep,Glob",
		"--strict-mcp-config",
		"--mcp-config",
		join(runDir(PARENT), `worker-${SPINE}-1.mcp.json`),
		"-p",
		"--model",
		"sonnet",
	]);

	const again = await portia("worker", "start", SPINE, "--parent", PARENT);
	expect(again.code).toBe(11);
	expect(again.err).toContain("already has a result");
});

it("workers rotate over the profile's accounts; one at its usage limit is benched, the retry spends none and goes to the other", async () => {
	const accounts = [
		{ name: "work", configDir: join(root, "claude-work") },
		{ name: "home", configDir: join(root, "claude-home") },
	];
	useProfile(
		{
			mode: "detached",
			command: process.execPath,
			args: [join(root, "worker.mjs")],
			accounts,
		},
		{ maxRetries: 0 },
	);
	const configOf = () =>
		JSON.parse(
			readFileSync(
				readWorker(runDir(PARENT), SPINE, readRows(runDir(PARENT)).rows)?.log ??
					"",
				"utf8",
			).split("\n")[0] ?? "",
		).config;
	await exited(await start("limit"));
	expect(configOf()).toBe(accounts[0]?.configDir);
	const w = await json(
		"worker",
		"wait",
		SPINE,
		"--parent",
		PARENT,
		"--poll",
		"0.05",
	);
	expect(w.code).toBe(11);
	expect(w.message).toMatch(
		/^usage-limit: account work is at its usage limit until \S+T15:00:00\.000Z \(You've hit your limit/,
	);
	const listed = await portia("accounts", "--json");
	expect(listed.code).toBe(0);
	expect(JSON.parse(listed.out)).toMatchObject([
		{ name: "work", limitedUntil: expect.stringMatching(/T15:00:00\.000Z$/) },
		{ name: "home" },
	]);
	const d = await json(
		"decide",
		"failure",
		SPINE,
		"--parent",
		PARENT,
		"--reason",
		w.message,
	);
	expect(d).toMatchObject({ answer: "retry", by: "rule" });

	// home is next in rotation, and work is benched, so home takes the retry and the one after.
	const s = await json("dispatch", SPINE, "--parent", PARENT);
	expect(s.code).toBe(0);
	process.env.WORKER_MODE = "limit";
	const st = await json("worker", "start", SPINE, "--parent", PARENT);
	expect(st).toMatchObject({ code: 0, account: "home" });
	await exited(st.pid);
	expect(configOf()).toBe(accounts[1]?.configDir);
	await json("worker", "wait", SPINE, "--parent", PARENT, "--poll", "0.05");

	// Both benched: dispatch refuses and portia accounts exits 10, until one is cleared.
	const refused = await portia("dispatch", SPINE, "--parent", PARENT);
	expect(refused.code).toBe(11);
	expect(refused.err).toContain("every account is at its usage limit");
	expect((await portia("accounts")).code).toBe(10);
	expect((await portia("accounts", "clear", "work")).out).toBe(
		"lifted the limit on work",
	);
	expect((await portia("accounts")).code).toBe(0);
});

it("a worker that exits without its result fails as stalled, with the reason", async () => {
	detached();
	await start("silent");
	const w = await json(
		"worker",
		"wait",
		SPINE,
		"--parent",
		PARENT,
		"--poll",
		"0.05",
	);
	expect(w).toMatchObject({
		code: 11,
		status: "failed",
		message: "stalled: the worker exited without writing its result",
	});
	expect(tracker.writes).toContainEqual({
		kind: "comment",
		key: SPINE,
		text: "Attempt 1: failed.\n\nstalled: the worker exited without writing its result",
	});
});

it("resume waits on a detached worker that is still alive instead of redispatching it", async () => {
	detached();
	await start("hang");
	const r = await json("resume", PARENT);
	expect(r.code, r.err).toBe(0);
	expect(r.actions).toEqual([
		{
			child: SPINE,
			action: "await-worker",
			detail: expect.stringMatching(
				/^attempt 1 runs detached: pid \d+ is working$/,
			),
		},
	]);
	const s = await json("status", PARENT, "--json");
	expect(s.workers).toEqual({ [SPINE]: "alive" });
	expect(s.states[SPINE]).toBe("running");
});

it("status stops a worker quiet for the stall window and records it failed; resume then asks for a decision", async () => {
	detached(0.01);
	const pid = await start("hang");
	await new Promise((r) => setTimeout(r, 1500));
	const s = await json("status", PARENT, "--json");
	expect(s.workers).toEqual({ [SPINE]: "stalled" });
	expect(s.states[SPINE]).toBe("failed");
	expect(s.warnings[0]).toMatch(
		/^ACME-201: stalled, no log output, worktree change or busy process for \d+ min; stopped and recorded as failed$/,
	);
	await exited(pid);
	expect(lastResult()?.data?.message).toMatch(/^stalled: no log output/);
	const r = await json("resume", PARENT);
	expect(r.actions).toEqual([
		{
			child: SPINE,
			action: "decide-failure",
			detail: "failed; ask portia decide failure",
		},
	]);
});

it("resume applies the result of a detached worker that finished while nothing waited", async () => {
	detached();
	await exited(await start("done"));
	const r = await json("resume", PARENT);
	expect(r.code, r.err).toBe(0);
	expect(r.actions).toEqual([
		{ child: SPINE, action: "land", detail: "done but not landed" },
	]);
	expect(lastResult()).toMatchObject({ status: "done", tokens: 10 });
});

it("a wait left over from an attempt the run moved past applies nothing and exits 10", async () => {
	detached(0.01);
	await start("hang");
	const stale = json(
		"worker",
		"wait",
		SPINE,
		"--parent",
		PARENT,
		"--poll",
		"3",
	);
	await new Promise((r) => setTimeout(r, 1000));
	expect((await json("status", PARENT, "--json")).workers).toEqual({
		[SPINE]: "stalled",
	});
	const second = await start("hang");
	const w = await stale;
	expect(w).toMatchObject({ code: 10, stale: true, duplicate: true });
	expect(w.message).toBe(
		"attempt 1 was superseded by attempt 2; nothing applied",
	);
	expect(realProcs.alive(second)).toBe(true);
	expect(
		readRows(runDir(PARENT)).rows.filter((r) => r.stage === "result"),
	).toMatchObject([{ attempt: 1, status: "failed" }]);
});

it("starting a newer attempt stops the older attempt's worker first", async () => {
	detached();
	const first = await start("hang");
	const second = await start("hang");
	expect(second).not.toBe(first);
	expect(realProcs.alive(first)).toBe(false);
	expect(realProcs.alive(second)).toBe(true);
});

it("worker start refuses to restart an attempt whose worker finished but was not collected", async () => {
	detached();
	await exited(await start("done"));
	const r = await portia("worker", "start", SPINE, "--parent", PARENT);
	expect(r.code).toBe(11);
	expect(r.err).toContain(
		"has finished; run portia worker wait to apply its result",
	);
});

it("worker start --note-file adds the person's answer to the brief the worker gets", async () => {
	detached();
	process.env.WORKER_MODE = "silent";
	await json("dispatch", SPINE, "--parent", PARENT);
	const note = join(root, "note.md");
	writeFileSync(note, "Use the existing helper.\n");
	const s = await json(
		"worker",
		"start",
		SPINE,
		"--parent",
		PARENT,
		"--note-file",
		note,
	);
	expect(s.code, s.err).toBe(0);
	expect(
		readFileSync(join(runDir(PARENT), `brief-${SPINE}-1.md`), "utf8"),
	).toMatch(/\n## Answer from the person\n\nUse the existing helper\.\n$/);
});

it("worker wait refuses a poll interval that is not a positive number", async () => {
	detached();
	await start("silent");
	for (const poll of ["abc", "0", "-1"]) {
		const r = await portia(
			"worker",
			"wait",
			SPINE,
			"--parent",
			PARENT,
			"--poll",
			poll,
		);
		expect(r.code).toBe(11);
		expect(r.err).toContain("--poll <seconds> must be a positive number");
	}
	expect(lastResult()).toBeUndefined();
});

it("with worker slots, a detached worker holds its slot by its own pid after the session that dispatched it ends, and frees it once it dies", async () => {
	detached(20, { perWorkerMb: 1 });
	// The dispatching session is gone at once: no owner pid runs.
	restores.push(
		useProbes({ freeMb: () => 1_000_000, ownerPid: () => 2 ** 22 + 7 }),
	);
	const pid = await start("hang");
	const dispatched = readRows(runDir(PARENT)).rows.filter(
		(r) => r.stage === "dispatched",
	);
	expect(dispatched).toHaveLength(1);
	const live = await json("status", PARENT, "--json");
	expect(live.slots).toMatchObject({ used: 1, running: [SPINE] });
	expect(live.workers).toEqual({ [SPINE]: "alive" });

	await realProcs.stop(pid);
	const dead = await json("status", PARENT, "--json");
	expect(dead.slots).toMatchObject({ used: 0, running: [] });
	expect(dead.warnings.join("\n")).toContain(`${SPINE}: stalled`);
	expect(lastResult()).toMatchObject({ child: SPINE, status: "failed" });
});
