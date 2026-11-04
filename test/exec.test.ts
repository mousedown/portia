import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { must, realExec, spawnExec } from "../src/core/exec";
import { PortiaProblem } from "../src/core/exit";

it("runs a command and captures stdout", async () => {
	const r = await realExec("git", ["--version"]);
	expect(r.code).toBe(0);
	expect(r.stdout).toContain("git version");
});
it("must throws PortiaProblem on a non-zero exit", async () => {
	await expect(
		must(realExec, "git", ["no-such-subcommand"]),
	).rejects.toBeInstanceOf(PortiaProblem);
});
it("kills a command and what it started once timeoutMs runs out", async () => {
	const start = Date.now();
	const r = await realExec("sh", ["-c", "sleep 5; echo late"], {
		timeoutMs: 100,
	});
	expect(Date.now() - start).toBeLessThan(3_000);
	expect(r).toMatchObject({ code: 124, timedOut: true });
	expect(r.stdout).not.toContain("late");
	expect(r.stderr).toContain("timed out after 100ms");
});
it("a command that finishes within timeoutMs keeps its own exit code", async () => {
	const r = await realExec("sh", ["-c", "echo hi; exit 3"], {
		timeoutMs: 5_000,
	});
	expect(r).toMatchObject({ code: 3, stdout: "hi\n" });
	expect(r.timedOut).toBeUndefined();
});
it("a timed command does not outlive Portia when Portia is stopped", async () => {
	// The port pool lives beside the run directory; a private parent keeps this
	// file off the pool every other test file in $TMPDIR shares.
	const dir = join(mkdtempSync(join(tmpdir(), "portia-exec-")), "run");
	mkdirSync(dir);
	const pidFile = join(dir, "pid");
	const script = join(dir, "run.ts");
	writeFileSync(
		script,
		`import { spawnExec } from ${JSON.stringify(resolve("src/core/exec.ts"))};
await spawnExec("sh", ["-c", "echo $$ > ${pidFile}; sleep 30"], { timeoutMs: 60_000 });`,
	);
	const portia = spawn("bun", [script], { stdio: "ignore" });
	// Stop it the moment the command is up: a stop in the instant after the spawn is the one
	// that once found no listener, and left the group running.
	const up = () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim();
	for (let i = 0; i < 5000 && !up(); i++)
		await new Promise((r) => setTimeout(r, 1));
	const pid = Number(readFileSync(pidFile, "utf8"));
	const exited = new Promise((r) => portia.on("exit", r));
	portia.kill("SIGTERM");
	await exited;
	// Signal 0 also answers for a zombie, which a CI runner's init may never reap, so ask who
	// is still running. A failure names them, which tells a slow reap from a real survivor.
	const running = () =>
		spawnSync("ps", ["-A", "-o", "pgid=,stat=,pid=,command="], {
			encoding: "utf8",
		})
			.stdout.split("\n")
			.map((l) => l.trim().split(/\s+/))
			.filter(([pgid, stat]) => Number(pgid) === pid && !stat?.startsWith("Z"))
			.map((f) => f.join(" "));
	for (let i = 0; i < 100 && running().length; i++)
		await new Promise((r) => setTimeout(r, 50));
	expect(running()).toEqual([]);
});

it("holds the stop listeners only while a timed command runs, even one that cannot start", async () => {
	const listening = () => process.listenerCount("SIGTERM");
	const before = listening();
	const running = spawnExec("sh", ["-c", "exit 0"], { timeoutMs: 60_000 });
	expect(listening()).toBe(before + 1);
	await running;
	expect(listening()).toBe(before);
	await spawnExec("no-such-command-portia", [], { timeoutMs: 60_000 }).catch(
		() => {},
	);
	expect(listening()).toBe(before);
});
