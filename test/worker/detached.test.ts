import {
	existsSync,
	mkdtempSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountStatus } from "../../src/core/accounts";
import { testProfile } from "../../src/core/config";
import { PortiaProblem } from "../../src/core/exit";
import { appendRow, readRows } from "../../src/core/runlog";
import {
	collect,
	logTokens,
	type Procs,
	probe,
	readRecord,
	readWorker,
	realProcs,
	running,
	startWorker,
	treeCpu,
	type WorkerRecord,
} from "../../src/worker/detached";
import { fakeExec } from "../helpers/fake-exec";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const MIN = 60_000;

/** Scripted processes: `live` holds the pids still running; `stop` ends one. */
function fakeProcs() {
	const live = new Set<number>();
	const started: { cmd: string; args: string[]; cwd: string; stdin: string }[] =
		[];
	const stopped: number[] = [];
	const seen: { env?: Record<string, string | undefined> } = {};
	const procs: Procs = {
		start(cmd, args, o) {
			started.push({ cmd, args, cwd: o.cwd, stdin: o.stdin });
			seen.env = o.env;
			writeFileSync(o.log, "");
			live.add(4242);
			return 4242;
		},
		alive: (pid) => live.has(pid),
		stop: (pid) => {
			stopped.push(pid);
			live.delete(pid);
		},
	};
	return { procs, live, started, stopped, seen };
}

function started(now = T0) {
	const dir = mkdtempSync(join(tmpdir(), "portia-worker-"));
	const p = fakeProcs();
	const rec = startWorker(
		{
			dir,
			key: "ACME-2",
			attempt: 1,
			role: "child",
			model: "sonnet",
			worktree: "/wt/ACME-2",
			brief: "the brief",
			workers: testProfile().workers,
			denyRules: ["Bash(git push*main*)"],
		},
		p.procs,
		() => now,
	);
	utimesSync(rec.log, new Date(now), new Date(now));
	return { dir, rec, ...p, env: p.seen.env };
}

const AUTH_FAILED = [
	{
		type: "assistant",
		error: "authentication_failed",
		is_api_error_message: true,
		message: {
			model: "<synthetic>",
			content: [{ type: "text", text: "Not logged in · Please run /login" }],
		},
	},
	{
		type: "result",
		subtype: "success",
		is_error: true,
		terminal_reason: "api_error",
		result: "Not logged in · Please run /login",
	},
];

const RESULT = {
	child: "ACME-2",
	status: "done",
	head: "abc1234",
	gates: { task: "pass", exit: "pass" },
	evidence: { F1: "ok" },
};
const quietGit = fakeExec((c) =>
	c.args[0] === "log"
		? { stdout: `${Math.floor(T0 / 1000)}\n` }
		: { stdout: "" },
).exec;

describe("startWorker", () => {
	it("runs the command headless in the worktree with the brief on stdin, and records it", () => {
		const s = started();
		expect(s.started).toEqual([
			{
				cmd: "claude",
				args: [
					"--output-format",
					"stream-json",
					"--verbose",
					"--settings",
					join(s.dir, "worker-ACME-2-1.settings.json"),
					"--add-dir",
					s.dir,
					"--tools",
					"Bash,Read,Edit,Write,Grep,Glob",
					"--strict-mcp-config",
					"--mcp-config",
					join(s.dir, "worker-ACME-2-1.mcp.json"),
					"-p",
					"--model",
					"sonnet",
				],
				cwd: "/wt/ACME-2",
				stdin: join(s.dir, "brief-ACME-2-1.md"),
			},
		]);
		expect(readFileSync(join(s.dir, "brief-ACME-2-1.md"), "utf8")).toBe(
			"the brief",
		);
		expect(s.rec).toMatchObject({
			child: "ACME-2",
			attempt: 1,
			pid: 4242,
			log: join(s.dir, "worker-ACME-2-1.log"),
			result: join(s.dir, "result-ACME-2-1.json"),
			startedAt: "2026-01-01T10:00:00.000Z",
		});
	});

	it("runs under the account it was given, through CLAUDE_CONFIG_DIR, and records it", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-worker-"));
		const p = fakeProcs();
		const rec = startWorker(
			{
				dir,
				key: "ACME-2",
				attempt: 1,
				role: "child",
				model: "sonnet",
				worktree: "/wt/ACME-2",
				brief: "the brief",
				workers: testProfile().workers,
				denyRules: [],
				account: { name: "work", configDir: "/c/work" },
			},
			p.procs,
			() => T0,
		);
		expect(p.seen.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/c/work" });
		expect(rec.account).toBe("work");
		expect(readRecord(dir, "ACME-2")?.account).toBe("work");
	});

	it("an account on the default login runs with CLAUDE_CONFIG_DIR removed, not inherited", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-worker-"));
		const p = fakeProcs();
		const rec = startWorker(
			{
				dir,
				key: "ACME-2",
				attempt: 1,
				role: "child",
				model: "sonnet",
				worktree: "/wt/ACME-2",
				brief: "the brief",
				workers: testProfile().workers,
				denyRules: [],
				account: { name: "personal", defaultLogin: true },
			},
			p.procs,
			() => T0,
		);
		expect(p.seen.env).toHaveProperty("CLAUDE_CONFIG_DIR", undefined);
		expect(rec.account).toBe("personal");
	});

	it("without an account it sets no CLAUDE_CONFIG_DIR and records none", () => {
		const s = started();
		expect(s.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
		expect(s.rec.account).toBeUndefined();
	});

	it("carries the profile's deny rules in its own settings, since it runs outside the session", () => {
		const s = started();
		expect(
			JSON.parse(
				readFileSync(join(s.dir, "worker-ACME-2-1.settings.json"), "utf8"),
			),
		).toEqual({ permissions: { deny: ["Bash(git push*main*)"] } });
	});

	it("is read back only for the child's latest dispatched attempt", () => {
		const s = started();
		appendRow(s.dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
		expect(readWorker(s.dir, "ACME-2", readRows(s.dir).rows)?.pid).toBe(4242);
		appendRow(s.dir, { child: "ACME-2", attempt: 2, stage: "dispatched" });
		expect(readWorker(s.dir, "ACME-2", readRows(s.dir).rows)).toBeUndefined();
		expect(readWorker(s.dir, "ACME-3", readRows(s.dir).rows)).toBeUndefined();
	});

	it("records the worker as soon as it starts, then adds its identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-worker-"));
		const p = fakeProcs();
		let seen: WorkerRecord | undefined;
		const rec = startWorker(
			{
				dir,
				key: "ACME-2",
				attempt: 1,
				role: "child",
				model: "sonnet",
				worktree: "/wt/ACME-2",
				brief: "the brief",
				workers: testProfile().workers,
				denyRules: [],
			},
			{
				...p.procs,
				// The ps call that names the process comes after the record is on disk.
				identity: () => {
					seen = readRecord(dir, "ACME-2");
					return "Thu Jan  1 10:00:00 2026";
				},
			},
			() => T0,
		);
		expect(seen).toMatchObject({ pid: 4242, attempt: 1 });
		expect(seen?.proc).toBeUndefined();
		expect(rec.proc).toBe("Thu Jan  1 10:00:00 2026");
		expect(readRecord(dir, "ACME-2")).toEqual(rec);
	});

	it("a torn worker record is a problem that names the file", () => {
		const s = started();
		writeFileSync(join(s.dir, "worker-ACME-2.json"), '{"child":"ACME-2","pi');
		expect(() => readRecord(s.dir, "ACME-2")).toThrow(PortiaProblem);
		expect(() => readRecord(s.dir, "ACME-2")).toThrow(/worker-ACME-2\.json/);
	});
});

describe("probe and collect", () => {
	const at = (s: ReturnType<typeof started>, now: number) => ({
		exec: quietGit,
		stallMin: 20,
		procs: s.procs,
		now: () => now,
	});

	it("a running worker that shows progress is alive, and nothing is collected", async () => {
		const s = started();
		expect(await probe(s.rec, at(s, T0 + 19 * MIN))).toEqual({
			state: "alive",
		});
		expect(await collect(s.rec, at(s, T0 + 19 * MIN))).toBeUndefined();
		expect(s.stopped).toEqual([]);
	});

	it("a worker that exited with its result is finished, with the log's tokens", async () => {
		const s = started();
		writeFileSync(s.rec.result, JSON.stringify(RESULT));
		writeFileSync(
			s.rec.log,
			[
				'{"type":"assistant"}',
				'{"type":"result","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}',
				"",
			].join("\n"),
		);
		s.live.clear();
		const c = await collect(s.rec, at(s, T0 + MIN));
		expect(c?.probe).toEqual({ state: "finished" });
		expect(c?.outcome).toMatchObject({ ok: true, result: { status: "done" } });
		expect(c?.tokens).toBe(1115);
	});

	it("a worker that wrote no file but whose log ends in a result line is finished from that line", async () => {
		const s = started();
		writeFileSync(
			s.rec.log,
			`${JSON.stringify({ type: "result", result: `\`\`\`json\n${JSON.stringify(RESULT)}\n\`\`\``, usage: { input_tokens: 4 } })}\n`,
		);
		s.live.clear();
		const c = await collect(s.rec, at(s, T0 + MIN));
		expect(c?.probe).toEqual({ state: "finished" });
		expect(c?.outcome).toMatchObject({ ok: true, result: { status: "done" } });
		expect(c?.tokens).toBe(4);
	});

	it("a worker that ended on its account's usage limit benches the account and says so", async () => {
		const s = started();
		const home = mkdtempSync(join(tmpdir(), "portia-acct-"));
		writeFileSync(
			s.rec.log,
			`${JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1767272400" })}\n`,
		);
		s.live.clear();
		const c = await collect(s.rec, { ...at(s, T0 + MIN), home });
		expect(c?.outcome).toEqual({
			ok: false,
			error:
				"usage-limit: account default is at its usage limit until 2026-01-01T13:00:00.000Z (Claude AI usage limit reached|1767272400)",
		});
		expect(
			accountStatus([{ name: "default" }], { home, now: T0 + MIN })[0],
		).toMatchObject({ limitedUntil: "2026-01-01T13:00:00.000Z" });
	});

	it("a worker that ended on a missing login benches the account until cleared and names its login", async () => {
		const s = started();
		const home = mkdtempSync(join(tmpdir(), "portia-acct-"));
		writeFileSync(
			s.rec.log,
			`${AUTH_FAILED.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
		s.live.clear();
		const accounts = [{ name: "personal", defaultLogin: true as const }];
		const rec = { ...s.rec, account: "personal" };
		const c = await collect(rec, { ...at(s, T0 + MIN), home, accounts });
		expect(c?.outcome).toEqual({
			ok: false,
			error:
				"not-logged-in: account personal (the default login) is not logged in (Not logged in · Please run /login); log it in, then run portia accounts clear personal",
		});
		expect(
			accountStatus(accounts, { home, now: T0 + 1000 * 24 * 60 * MIN })[0],
		).toMatchObject({ notLoggedIn: true });
	});

	it("names the config dir of a logged-out account that has one", async () => {
		const s = started();
		const home = mkdtempSync(join(tmpdir(), "portia-acct-"));
		writeFileSync(
			s.rec.log,
			`${AUTH_FAILED.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
		s.live.clear();
		const c = await collect(
			{ ...s.rec, account: "work" },
			{
				...at(s, T0 + MIN),
				home,
				accounts: [{ name: "work", configDir: "/c/work" }],
			},
		);
		expect(c?.outcome).toMatchObject({
			ok: false,
			error: expect.stringMatching(
				/^not-logged-in: account work \(configDir \/c\/work\) is not logged in/,
			),
		});
	});

	it("a worker that exited without a result has stalled", async () => {
		const s = started();
		s.live.clear();
		const c = await collect(s.rec, at(s, T0 + MIN));
		expect(c?.outcome).toEqual({
			ok: false,
			error: "stalled: the worker exited without writing its result",
		});
		expect(c?.tokens).toBe(0);
	});

	it("a live worker quiet for the window has stalled, and is stopped", async () => {
		const s = started();
		const c = await collect(s.rec, at(s, T0 + 21 * MIN));
		expect(c?.outcome).toEqual({
			ok: false,
			error:
				"stalled: no log output, worktree change or busy process for 21 min",
		});
		expect(s.stopped).toEqual([4242]);
	});

	it("a worker waiting its turn for a lock is alive, not stalled", async () => {
		const s = started();
		expect(s.env?.PORTIA_WAIT_FILE).toBe(s.rec.log.replace(/\.log$/, ".wait"));
		writeFileSync(s.env?.PORTIA_WAIT_FILE ?? "", "");
		const beat = new Date(T0 + 20 * MIN);
		utimesSync(s.env?.PORTIA_WAIT_FILE ?? "", beat, beat);
		expect(await probe(s.rec, at(s, T0 + 21 * MIN))).toEqual({
			state: "alive",
		});
	});

	it("a quiet worker that already wrote its result is finished, and stopped", async () => {
		const s = started();
		writeFileSync(s.rec.result, JSON.stringify(RESULT));
		utimesSync(s.rec.result, new Date(T0), new Date(T0));
		const c = await collect(s.rec, at(s, T0 + 21 * MIN));
		expect(c?.probe).toEqual({ state: "finished" });
		expect(s.stopped).toEqual([4242]);
	});

	it("a commit or a changed file in the worktree counts as progress", async () => {
		const s = started();
		const now = T0 + 25 * MIN;
		const committed = fakeExec((c) =>
			c.args[0] === "log"
				? { stdout: `${Math.floor((T0 + 10 * MIN) / 1000)}\n` }
				: { stdout: "" },
		).exec;
		expect(await probe(s.rec, { ...at(s, now), exec: committed })).toEqual({
			state: "alive",
		});

		const wt = mkdtempSync(join(tmpdir(), "portia-wt-"));
		writeFileSync(join(wt, "a.ts"), "x");
		utimesSync(
			join(wt, "a.ts"),
			new Date(T0 + 24 * MIN),
			new Date(T0 + 24 * MIN),
		);
		const dirty = fakeExec((c) =>
			c.args[0] === "status"
				? { stdout: " M a.ts\n" }
				: { code: 128, stdout: "" },
		).exec;
		const rec: WorkerRecord = { ...s.rec, worktree: wt };
		expect(await probe(rec, { ...at(s, now), exec: dirty })).toEqual({
			state: "alive",
		});
	});

	it("a pid now held by a different process is not the worker: it is dead, and is never signalled", async () => {
		const s = started();
		const rec: WorkerRecord = { ...s.rec, proc: "Thu Jan  1 10:00:00 2026" };
		const procs: Procs = {
			...s.procs,
			identity: () => "Fri Jan  2 08:00:00 2026",
		};
		expect(running(rec, procs)).toBe(false);
		const c = await collect(rec, { ...at(s, T0 + MIN), procs });
		expect(c?.probe).toMatchObject({ state: "stalled" });
		expect(s.stopped).toEqual([]);
		expect(running(rec, { ...procs, identity: () => rec.proc })).toBe(true);
	});

	it("a start time recorded under another locale is still the worker: it stays alive", () => {
		const s = started();
		const rec: WorkerRecord = { ...s.rec, proc: "Sat 14 Nov 05:46:36 2026" };
		const same: Procs = {
			...s.procs,
			identity: () => "Sat Nov 14 05:46:36 2026",
		};
		expect(running(rec, same)).toBe(true);
		const later: Procs = {
			...s.procs,
			identity: () => "Sat Nov 14 05:46:37 2026",
		};
		expect(running(rec, later)).toBe(false);
	});

	it("a quiet worker whose processes keep using CPU is alive; once they idle it stalls", async () => {
		const s = started();
		let cpu = 0;
		const procs: Procs = { ...s.procs, cpu: () => cpu };
		const ctx = (now: number) => ({ ...at(s, now), procs });
		expect(await probe(s.rec, ctx(T0 + 10 * MIN))).toEqual({ state: "alive" });
		cpu = 120;
		expect(await probe(s.rec, ctx(T0 + 25 * MIN))).toEqual({ state: "alive" });
		cpu = 121;
		expect(await probe(s.rec, ctx(T0 + 44 * MIN))).toEqual({ state: "alive" });
		expect(await probe(s.rec, ctx(T0 + 46 * MIN))).toMatchObject({
			state: "stalled",
		});
	});

	it("a worker whose log is fresh is alive without a look at its worktree or its processes", async () => {
		const s = started();
		const calls = fakeExec(() => ({ stdout: "" }));
		let samples = 0;
		const procs: Procs = {
			...s.procs,
			cpu: () => {
				samples++;
				return 0;
			},
		};
		const ctx = (now: number) => ({
			...at(s, now),
			exec: calls.exec,
			procs,
		});
		utimesSync(s.rec.log, new Date(T0 + 5 * MIN), new Date(T0 + 5 * MIN));
		expect(await probe(s.rec, ctx(T0 + 6 * MIN))).toEqual({ state: "alive" });
		expect(await probe(s.rec, ctx(T0 + 6 * MIN + 5_000))).toEqual({
			state: "alive",
		});
		expect(calls.calls).toEqual([]);
		// One CPU sample stands for the next ten seconds.
		expect(samples).toBe(1);
		expect(await probe(s.rec, ctx(T0 + 6 * MIN + 11_000))).toEqual({
			state: "alive",
		});
		expect(samples).toBe(2);
	});

	it("a result line longer than the log's tail is still found", async () => {
		const s = started();
		const long = `\`\`\`json\n${JSON.stringify({ ...RESULT, evidence: { F1: "x".repeat(300_000) } })}\n\`\`\``;
		writeFileSync(
			s.rec.log,
			[
				...Array.from({ length: 2000 }, (_, i) =>
					JSON.stringify({ type: "assistant", n: i, pad: "y".repeat(100) }),
				),
				JSON.stringify({
					type: "result",
					result: long,
					usage: { input_tokens: 9 },
				}),
				"",
			].join("\n"),
		);
		s.live.clear();
		const c = await collect(s.rec, at(s, T0 + MIN));
		expect(c?.probe).toEqual({ state: "finished" });
		expect(c?.outcome).toMatchObject({ ok: true, result: { status: "done" } });
		expect(c?.tokens).toBe(9);
	});

	it("a stalled worker counts the tokens its assistant messages used, once per message", async () => {
		const s = started();
		const msg = (id: string, input: number) =>
			JSON.stringify({
				type: "assistant",
				message: {
					id,
					usage: { input_tokens: input, output_tokens: 1 },
				},
			});
		writeFileSync(
			s.rec.log,
			[
				'{"type":"system"}',
				msg("m1", 10),
				msg("m1", 10),
				'{"type":"user","message":{"content":"tool output with \\"usage\\""}}',
				msg("m2", 100),
				"not json",
				"",
			].join("\n"),
		);
		utimesSync(s.rec.log, new Date(T0), new Date(T0));
		const c = await collect(s.rec, at(s, T0 + 21 * MIN));
		expect(c?.probe).toMatchObject({ state: "stalled" });
		expect(c?.tokens).toBe(11 + 101);
	});

	it("a worktree that is gone shows no progress rather than failing", async () => {
		const s = started();
		const gone: typeof quietGit = async () => {
			throw new Error("spawn ENOENT");
		};
		expect(
			await probe(s.rec, { ...at(s, T0 + 21 * MIN), exec: gone }),
		).toMatchObject({ state: "stalled" });
	});
});

it("treeCpu sums the worker, its process group and its descendants, in either ps time format", () => {
	const out = [
		"  100     1   100   1:02.50",
		"  101   100   100   0:10.00",
		"  102   101   102   01:00:00",
		"  103     1   100   1-00:00:01",
		"  200     1   200   9:00.00",
	].join("\n");
	expect(treeCpu(out, 100)).toBe(62.5 + 10 + 3600 + 86_401);
	expect(treeCpu(out, 999)).toBeUndefined();
});

it("logTokens is 0 without a result line", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-log-"));
	expect(logTokens(join(dir, "none.log"))).toBe(0);
	writeFileSync(join(dir, "plain.log"), "working\nnot json\n");
	expect(logTokens(join(dir, "plain.log"))).toBe(0);
});

it("the real process control starts a detached process, sees it alive, and stops it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-proc-"));
	const script = join(dir, "worker.mjs");
	writeFileSync(
		script,
		'let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { console.log("got " + s + " " + process.argv.slice(2).join(" ")); setTimeout(() => {}, 60_000); });',
	);
	writeFileSync(join(dir, "brief.md"), "the brief");
	const log = join(dir, "out.log");
	const pid = realProcs.start(process.execPath, [script, "-p"], {
		cwd: dir,
		stdin: join(dir, "brief.md"),
		log,
	});
	const until = async (ok: () => boolean) => {
		for (let i = 0; i < 100 && !ok(); i++)
			await new Promise((r) => setTimeout(r, 50));
	};
	await until(() => existsSync(log) && readFileSync(log, "utf8").length > 0);
	expect(readFileSync(log, "utf8")).toBe("got the brief -p\n");
	expect(realProcs.alive(pid)).toBe(true);
	expect(realProcs.identity?.(pid)).toMatch(/\d{4}$/);
	expect(realProcs.cpu?.(pid)).toBeGreaterThanOrEqual(0);
	await realProcs.stop(pid);
	await until(() => !realProcs.alive(pid));
	expect(realProcs.alive(pid)).toBe(false);
});

it("the real process control removes a variable the worker env sets to undefined", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-proc-"));
	const script = join(dir, "worker.mjs");
	writeFileSync(
		script,
		'console.log(process.env.CLAUDE_CONFIG_DIR ?? "unset", process.env.PORTIA_X);',
	);
	writeFileSync(join(dir, "brief.md"), "");
	const log = join(dir, "out.log");
	const saved = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = "/from/the/orchestrator";
	try {
		realProcs.start(process.execPath, [script], {
			cwd: dir,
			stdin: join(dir, "brief.md"),
			log,
			env: { CLAUDE_CONFIG_DIR: undefined, PORTIA_X: "kept" },
		});
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = saved;
	}
	for (let i = 0; i < 100 && !readFileSync(log, "utf8"); i++)
		await new Promise((r) => setTimeout(r, 50));
	expect(readFileSync(log, "utf8")).toBe("unset kept\n");
});

it("the real process control starts a worker outside its own process tree, so killing the starter leaves it running", async () => {
	const { execFileSync } = await import("node:child_process");
	const dir = mkdtempSync(join(tmpdir(), "portia-proc-"));
	const script = join(dir, "worker.mjs");
	writeFileSync(script, "setTimeout(() => {}, 60_000);");
	writeFileSync(join(dir, "brief.md"), "");
	const pid = realProcs.start(process.execPath, [script], {
		cwd: dir,
		stdin: join(dir, "brief.md"),
		log: join(dir, "out.log"),
	});
	try {
		expect(realProcs.alive(pid)).toBe(true);
		const ppid = Number(
			execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
				encoding: "utf8",
			}).trim(),
		);
		// A tree kill of the starter (a Bash tool's time limit on `portia drive`) walks its
		// children by parent pid; the worker is not one of them.
		expect(ppid).not.toBe(process.pid);
		const pgid = Number(
			execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
				encoding: "utf8",
			}).trim(),
		);
		// It still leads its own group, so stop reaches the commands it runs.
		expect(pgid).toBe(pid);
	} finally {
		await realProcs.stop(pid);
	}
	expect(realProcs.alive(pid)).toBe(false);
});

it("the real process control refuses a command it cannot start", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-proc-"));
	writeFileSync(join(dir, "brief.md"), "");
	expect(() =>
		realProcs.start(join(dir, "no-such-command"), [], {
			cwd: dir,
			stdin: join(dir, "brief.md"),
			log: join(dir, "out.log"),
		}),
	).toThrow(PortiaProblem);
});
