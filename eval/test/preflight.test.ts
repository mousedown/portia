import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOrchestrated, claudeSerial, none, portia } from "../src/arms";
import type { Exec } from "../src/arms/claude";
import {
	PREFLIGHT_USD,
	type PreflightCheck,
	preflight,
} from "../src/preflight";
import { type LoadedSuite, loadSuite } from "../src/suite";

// Nothing here clones, pushes or starts Claude Code: a fake exec records each command and
// answers it the way the real tool would.
const suiteFile = join(import.meta.dir, "../suites/v1/suite.json");
const withRemote = (s: LoadedSuite, remote?: string): LoadedSuite => ({
	...s,
	repos: s.repos.map((r) => ({ ...r, remote })),
});

function fakeExec(o: { reply?: string; children?: string[]; push?: number }) {
	const calls: string[][] = [];
	const exec: Exec = async (cmd) => {
		calls.push(cmd);
		if (cmd[0] === "claude")
			return {
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({
					type: "result",
					subtype: "success",
					result: o.reply ?? "OK",
					total_cost_usd: 0.003,
					usage: { input_tokens: 40, output_tokens: 2 },
					modelUsage: { "claude-sonnet": { inputTokens: 40, outputTokens: 2 } },
				}),
			};
		if (cmd[0] === "git" && cmd[1] === "push")
			return { exitCode: o.push ?? 0, stdout: "", stderr: "denied" };
		if (cmd[0] === "portia") {
			const out = cmd[cmd.indexOf("--out") + 1] as string;
			writeFileSync(
				out,
				JSON.stringify({
					children: (o.children ?? []).map((key) => ({ key })),
				}),
			);
		}
		return { exitCode: 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

const profiles = () => {
	const dir = mkdtempSync(join(tmpdir(), "preflight-profiles-"));
	writeFileSync(join(dir, "acme-shop.ts"), "export default {};\n");
	return dir;
};
const ok = (cs: PreflightCheck[]) => cs.every((c) => c.ok);
const named = (cs: PreflightCheck[], name: string) =>
	cs.find((c) => c.name === name);

describe("preflight", () => {
	it("a paid arm with no login fails before any session starts", async () => {
		const { exec, calls } = fakeExec({});
		const checks = await preflight({
			suite: loadSuite(suiteFile),
			arm: claudeOrchestrated,
			epicKey: "ACME-400",
			root: process.cwd(),
			exec,
			env: { PATH: process.env.PATH },
		});
		expect(named(checks, "login")).toMatchObject({ ok: false });
		expect(named(checks, "login")?.detail).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(calls.some((c) => c[0] === "claude")).toBe(false);
	});

	it("checks the login with one capped one-word session on the pinned model", async () => {
		const suite = loadSuite(suiteFile);
		const { exec, calls } = fakeExec({});
		const checks = await preflight({
			suite,
			arm: claudeOrchestrated,
			epicKey: "ACME-400",
			root: process.cwd(),
			exec,
			env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "t" },
		});
		expect(ok(checks)).toBe(true);
		const claude = calls.filter((c) => c[0] === "claude");
		expect(claude).toHaveLength(1);
		const cmd = claude[0] as string[];
		expect(cmd[cmd.indexOf("--model") + 1]).toBe(suite.model);
		expect(cmd[cmd.indexOf("--max-budget-usd") + 1]).toBe(
			PREFLIGHT_USD.toFixed(2),
		);
	});

	it("fails the login when the session does not answer", async () => {
		const { exec } = fakeExec({ reply: "Invalid API key" });
		const checks = await preflight({
			suite: loadSuite(suiteFile),
			arm: claudeSerial,
			epicKey: "ACME-400",
			root: process.cwd(),
			exec,
			env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "t" },
		});
		expect(named(checks, "login")).toMatchObject({ ok: false });
	});

	it("a free control spends nothing and needs no login", async () => {
		const { exec, calls } = fakeExec({});
		const checks = await preflight({
			suite: loadSuite(suiteFile),
			arm: none,
			epicKey: "ACME-400",
			root: process.cwd(),
			exec,
			env: { PATH: process.env.PATH },
		});
		expect(ok(checks)).toBe(true);
		expect(named(checks, "login")).toBeUndefined();
		expect(calls.some((c) => c[0] === "claude")).toBe(false);
	});

	it("for Portia: the profile, a dry-run push to the remote and the epic read from the tracker", async () => {
		const remote = "git@github.com:mousedown/acme-shop.git";
		const { exec, calls } = fakeExec({
			children: ["ACME-404", "ACME-401", "ACME-402", "ACME-403"],
		});
		const checks = await preflight({
			suite: withRemote(loadSuite(suiteFile), remote),
			arm: portia,
			epicKey: "ACME-400",
			root: process.cwd(),
			exec,
			env: {
				PATH: process.env.PATH,
				CLAUDE_CODE_OAUTH_TOKEN: "t",
				PORTIA_PROFILES_DIR: profiles(),
			},
		});
		expect(checks.map((c) => [c.name, c.ok])).toEqual([
			["tickets", true],
			["clone and setup", true],
			["portia profile", true],
			["push to the tracker's repo", true],
			["epic read from the tracker", true],
			["login", true],
		]);
		expect(calls).toContainEqual([
			"git",
			"remote",
			"set-url",
			"origin",
			remote,
		]);
		const push = calls.find((c) => c[0] === "git" && c[1] === "push");
		expect(push).toContain("--dry-run");
	});

	it("for Portia: a missing profile, a missing remote, a refused push or other children each fail", async () => {
		const base = {
			arm: portia,
			epicKey: "ACME-400",
			root: process.cwd(),
		};
		const env = { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "t" };
		const remote = "git@github.com:mousedown/acme-shop.git";
		const noProfile = await preflight({
			...base,
			suite: withRemote(loadSuite(suiteFile), remote),
			exec: fakeExec({}).exec,
			env: {
				...env,
				PORTIA_PROFILES_DIR: mkdtempSync(join(tmpdir(), "none-")),
			},
		});
		expect(named(noProfile, "portia profile")?.detail).toContain(
			"no Portia profile",
		);
		const noRemote = await preflight({
			...base,
			suite: withRemote(loadSuite(suiteFile)),
			exec: fakeExec({
				children: ["ACME-401", "ACME-402", "ACME-403", "ACME-404"],
			}).exec,
			env: { ...env, PORTIA_PROFILES_DIR: profiles() },
		});
		expect(named(noRemote, "push to the tracker's repo")?.detail).toContain(
			"no remote",
		);
		const refused = await preflight({
			...base,
			suite: withRemote(loadSuite(suiteFile), remote),
			exec: fakeExec({
				push: 128,
				children: ["ACME-401", "ACME-402", "ACME-403", "ACME-404"],
			}).exec,
			env: { ...env, PORTIA_PROFILES_DIR: profiles() },
		});
		expect(named(refused, "push to the tracker's repo")).toMatchObject({
			ok: false,
		});
		const other = await preflight({
			...base,
			suite: withRemote(loadSuite(suiteFile), remote),
			exec: fakeExec({ children: ["ACME-401"] }).exec,
			env: { ...env, PORTIA_PROFILES_DIR: profiles() },
		});
		expect(named(other, "epic read from the tracker")?.detail).toContain(
			"the tracker has ACME-401",
		);
	});
});
