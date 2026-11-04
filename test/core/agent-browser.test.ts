import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import cfg from "../fixtures/profile";

it("uses codex review --base main, which needs no diff file", () => {
	expect(cfg.secondVendor).toBe("codex review --base main");
	expect(cfg.secondVendor).not.toContain("{diff}");
});

// Runs the real template with stub binaries: `fail` names the agent-browser subcommand that fails.
const run = (fail?: string) => {
	const bin = mkdtempSync(join(tmpdir(), "portia-ab-"));
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub("bun", `echo $$ > ${bin}/dev.pid; exec sleep 30`);
	stub("curl", "exit 0");
	stub(
		"agent-browser",
		`echo "$1" >> ${bin}/calls; [ "$1" = "${fail ?? "none"}" ] && exit 7; exit 0`,
	);
	const cmd = cfg.agentBrowser
		.replaceAll("{baseUrl}", "http://localhost:3100")
		.replaceAll("{parent}", `t${process.pid}`);
	const r = spawnSync("sh", ["-c", cmd], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	});
	const pid = Number(readFileSync(join(bin, "dev.pid"), "utf8"));
	const isAlive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	// The script's kill is asynchronous: poll for exit (up to 2s) rather than checking once.
	for (let i = 0; i < 40 && isAlive(); i++)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	const alive = isAlive();
	const calls = existsSync(join(bin, "calls"))
		? readFileSync(join(bin, "calls"), "utf8").trim().split("\n")
		: [];
	return { code: r.status, alive, calls };
};

it("opens the home page, snapshots, closes, and kills the dev server", () => {
	const r = run();
	expect(r).toEqual({
		code: 0,
		alive: false,
		calls: ["open", "snapshot", "close"],
	});
});

it("exits non-zero and still cleans up when open fails", () => {
	const r = run("open");
	expect(r.code).not.toBe(0);
	expect(r.alive).toBe(false);
	expect(r.calls).toEqual(["open", "close"]);
});

it("exits non-zero and still cleans up when snapshot fails", () => {
	const r = run("snapshot");
	expect(r.code).toBe(7);
	expect(r.alive).toBe(false);
	expect(r.calls).toEqual(["open", "snapshot", "close"]);
});
