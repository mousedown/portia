import { describe, expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { secretHits, secretStep } from "../../src/gate/secrets";
import { fakeExec } from "../helpers/fake-exec";

const ALNUM = "Q3tZ7rKx2M5vB8nWp4Ls9Hd6Jf1Gc0Ya";
const UPPER = "Q3TZ7RKX2M5VB8NW";
const fake = {
	pem: ["-----BEGIN", "RSA PRIVATE", "KEY-----"].join(" "),
	openssh: ["-----BEGIN", "OPENSSH PRIVATE", "KEY-----"].join(" "),
	aws: `AK${"IA"}${UPPER}`,
	ghp: `gh${"p_"}${ALNUM}abcd`,
	gho: `gh${"o_"}${ALNUM}efgh`,
	ghs: `gh${"s_"}${ALNUM}ijkl`,
	pat: `github${"_pat_"}${ALNUM.slice(0, 22)}_${ALNUM}${ALNUM.slice(0, 27)}`,
	stripe: `sk${"_live_"}${ALNUM.slice(0, 24)}`,
	slack: `xo${"xb-"}1234567890-${ALNUM.slice(0, 24)}`,
	entropy: `${ALNUM.slice(0, 12)}+/${ALNUM.slice(12, 26)}`,
};

const diffOf = (file: string, ...added: string[]) =>
	[
		`diff --git a/${file} b/${file}`,
		`+++ b/${file}`,
		`@@ -10,0 +11,${added.length} @@`,
		...added.map((l) => `+${l}`),
	].join("\n");
const rules = (d: string, allow: string[] = []) =>
	secretHits(d, allow).map((h) => h.rule);

describe("secretHits", () => {
	it.each([
		["private-key", fake.pem],
		["private-key", fake.openssh],
		["aws-access-key-id", `const id = "${fake.aws}";`],
		["github-token", `token: ${fake.ghp}`],
		["github-token", `run(${JSON.stringify(fake.gho)})`],
		["github-token", `x = '${fake.ghs}'`],
		["github-token", `GH=${fake.pat}`],
		["stripe-live-key", `stripe(${JSON.stringify(fake.stripe)})`],
		["slack-token", `const t = '${fake.slack}'`],
		["assigned-secret", `const API_KEY = "${fake.entropy}";`],
		["assigned-secret", `clientSecret: '${fake.entropy}',`],
		["assigned-secret", `DB_PASSWORD=${JSON.stringify(fake.entropy)}`],
		["assigned-secret", `authToken := "${fake.entropy}"`],
		["assigned-secret", `export STRIPE_SECRET=${fake.entropy}`],
		["assigned-secret", `api_key: ${fake.entropy}`],
		[
			"github-token",
			`a = "gh${"p_"}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; b = "${fake.ghp}"`,
		],
	])("flags %s", (rule, line) => {
		expect(rules(diffOf("src/a.ts", line))).toEqual([rule]);
	});

	it.each([
		`const API_KEY = "xxxxxxxxxxxxxxxxxxxxxxxx";`,
		`const API_KEY = "changeme-changeme-changeme";`,
		`const API_KEY = "<your-api-key-goes-here>";`,
		`const API_KEY = "${"$"}{process.env.API_KEY_FROM_ENV}";`,
		`apiKey: "your-example-api-key-1234567890"`,
		`const id = "AK${"IA"}IOSFODNN7EXAMPLE";`,
		`token: "gh${"p_"}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`,
		`const t = 'xo${"xb-"}xxxxxxxxxx-xxxxxxxxxxxx'`,
		`const API_KEY = process.env.API_KEY;`,
		`const PASSWORD = "aaaaaaaaaaaaaaaaaaaaaaaa";`,
		`const keyboard = "${fake.entropy}";`,
		`const PUBLISHABLE_KEY = "${fake.entropy}";`,
		`const TOKEN_URL = "https://example.org/oauth/token/refresh";`,
		`const SHORT_TOKEN = "a1B2c3D4";`,
		"API_KEY=changeme-changeme-changeme",
		`DB_PASSWORD=${"$"}{DB_PASSWORD_FROM_THE_VAULT}`,
		"token = response.data.access_token2",
		"apiKey: settings.paymentsProvider.liveApiKey",
	])("ignores %s", (line) => {
		expect(rules(diffOf("src/a.ts", line))).toEqual([]);
	});

	it("reports the new file's line number, never the line itself", () => {
		const d = [
			diffOf("src/a.ts", "ok", `const API_KEY = "${fake.entropy}";`),
			"diff --git a/src/b.ts b/src/b.ts",
			"+++ b/src/b.ts",
			"@@ -1 +1 @@",
			"-old",
			`+${fake.pem}`,
		].join("\n");
		const hits = secretHits(d, []);
		expect(hits).toEqual([
			{ rule: "assigned-secret", file: "src/a.ts", line: 12 },
			{ rule: "private-key", file: "src/b.ts", line: 1 },
		]);
		expect(JSON.stringify(hits)).not.toContain(fake.entropy);
	});

	it("skips files the allow-list matches, and only those", () => {
		const d = [
			diffOf("test/fixtures/keys/id_rsa", fake.pem),
			diffOf("src/a.ts", fake.pem),
		].join("\n");
		expect(
			secretHits(d, ["test/fixtures/**"]).map((h) => `${h.rule} ${h.file}`),
		).toEqual(["private-key src/a.ts"]);
		expect(secretHits(d, [])).toHaveLength(2);
	});

	it("reads an added line that starts with ++ as content, not a file header", () => {
		const d = [
			"+++ b/src/a.ts",
			"@@ -0,0 +1,2 @@",
			"+++ b/elsewhere",
			`+${fake.pem}`,
		].join("\n");
		expect(secretHits(d, ["elsewhere"])).toEqual([
			{ rule: "private-key", file: "src/a.ts", line: 2 },
		]);
	});

	it("reads a path git quoted", () => {
		const d = [
			'+++ "b/src/caf\\303\\251 \\"q\\".ts"',
			"@@ -0,0 +1 @@",
			`+${fake.pem}`,
		].join("\n");
		expect(secretHits(d, [])).toEqual([
			{ rule: "private-key", file: 'src/café "q".ts', line: 1 },
		]);
	});

	it("ignores removed lines and deleted files", () => {
		const d = [
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			`-${fake.pem}`,
			"+++ b/src/a.ts",
			"@@ -3 +3 @@",
			`-const t = '${fake.slack}'`,
			"+const t = process.env.SLACK_TOKEN",
		].join("\n");
		expect(secretHits(d, [])).toEqual([]);
	});
});

describe("secretStep", () => {
	const profile = testProfile();
	const step = (handler: Parameters<typeof fakeExec>[0]) =>
		secretStep(fakeExec(handler).exec, "/wt", profile, {
			base: "abc",
			head: "def",
		});

	it("fails with file:line and rule, saying secret, without echoing the value", async () => {
		const s = await step((c) =>
			c.args[0] === "diff"
				? { stdout: diffOf("src/a.ts", `const t = '${fake.slack}'`) }
				: undefined,
		);
		expect(s).toEqual({
			name: "secrets",
			ok: false,
			tail: "secret slack-token: src/a.ts:11",
		});
		expect(s.tail).not.toContain(fake.slack);
	});

	it("diffs base...head and passes a clean diff", async () => {
		const { exec, calls } = fakeExec((c) =>
			c.args[0] === "diff" ? { stdout: diffOf("src/a.ts", "ok") } : undefined,
		);
		const s = await secretStep(exec, "/wt", profile, {
			base: "abc",
			head: "def",
		});
		expect(s.ok).toBe(true);
		expect(calls).toEqual([
			expect.objectContaining({
				cmd: "git",
				args: [
					"diff",
					"-U0",
					"--no-color",
					"--no-ext-diff",
					"--src-prefix=a/",
					"--dst-prefix=b/",
					"abc...def",
				],
				cwd: "/wt",
			}),
		]);
	});

	it("reads the diff whatever the user's git config says about colour and prefixes", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { realExec } = await import("../../src/core/exec");
		const repo = mkdtempSync(join(tmpdir(), "secrets-"));
		const git = (...a: string[]) => realExec("git", a, { cwd: repo });
		await git("init", "-q");
		await git("config", "user.email", "t@t");
		await git("config", "user.name", "t");
		await git("config", "color.ui", "always");
		await git("config", "diff.noprefix", "true");
		await git("commit", "-q", "--allow-empty", "-m", "a");
		writeFileSync(join(repo, "a.ts"), `${fake.pem}\n`);
		await git("add", ".");
		await git("commit", "-q", "-m", "b");
		const s = await secretStep(realExec, repo, profile, {
			base: "HEAD~1",
			head: "HEAD",
		});
		expect(s).toEqual({
			name: "secrets",
			ok: false,
			tail: "secret private-key: a.ts:1",
		});
	});

	it("fails closed when the diff fails", async () => {
		const s = await step((c) =>
			c.args[0] === "diff" ? { code: 128, stderr: "bad revision" } : undefined,
		);
		expect(s).toMatchObject({ ok: false, tail: "bad revision" });
	});

	it("runs the profile's scan command with {base} and {head}, withholding its output", async () => {
		const p = {
			...profile,
			gates: {
				...profile.gates,
				secretScan: {
					cmd: "gitleaks git --log-opts={base}..{head}",
					allow: [],
				},
			},
		};
		const { exec, calls } = fakeExec((c) =>
			c.cmd === "sh" ? { code: 1, stdout: `leak: ${fake.aws}` } : undefined,
		);
		const s = await secretStep(
			exec,
			"/wt",
			p,
			{ base: "abc", head: "def" },
			{ X: "1" },
		);
		expect(calls.at(-1)).toMatchObject({
			cmd: "sh",
			args: ["-c", "gitleaks git --log-opts=abc..def"],
			cwd: "/wt",
			env: { X: "1" },
		});
		expect(s.ok).toBe(false);
		expect(s.tail).toContain("secret");
		expect(s.tail).not.toContain(fake.aws);
		const clean = await secretStep(fakeExec().exec, "/wt", p, {
			base: "abc",
			head: "def",
		});
		expect(clean).toEqual({ name: "secrets", ok: true, tail: "" });
	});
});
