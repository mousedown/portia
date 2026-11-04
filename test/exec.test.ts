import { spawn } from "node:child_process";
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
import { must, realExec } from "../src/core/exec";
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
	for (let i = 0; i < 100 && !existsSync(pidFile); i++)
		await new Promise((r) => setTimeout(r, 50));
	const pid = Number(readFileSync(pidFile, "utf8"));
	const exited = new Promise((r) => portia.on("exit", r));
	portia.kill("SIGTERM");
	await exited;
	// The group's end is not instant, and a busy machine takes longer: wait for it, up to a limit.
	const gone = () => {
		try {
			process.kill(-pid, 0);
			return false;
		} catch {
			return true;
		}
	};
	for (let i = 0; i < 100 && !gone(); i++)
		await new Promise((r) => setTimeout(r, 50));
	expect(gone()).toBe(true);
});
