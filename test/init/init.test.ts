import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/main";
import { loadProfileFile } from "../../src/core/config";
import { EXIT } from "../../src/core/exit";
import {
	defaultWaveCap,
	detect,
	githubSlug,
	JIRA_TRANSITIONS,
	mergeAnswers,
	renderProfile,
} from "../../src/init/profile";
import { fakeExec } from "../helpers/fake-exec";

const repoDir = (scripts: Record<string, string> = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "portia-init-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
	writeFileSync(join(dir, "bun.lock"), "");
	return dir;
};
const gitFor = (remote: string) =>
	fakeExec((c) =>
		c.args[0] === "remote"
			? { stdout: `${remote}\n` }
			: c.args[0] === "rev-parse"
				? { stdout: ".git\n" }
				: undefined,
	).exec;

describe("githubSlug", () => {
	it("reads ssh and https remotes", () => {
		expect(githubSlug("git@github.com:acme/widget.git")).toBe("acme/widget");
		expect(githubSlug("https://github.com/acme/widget")).toBe("acme/widget");
		expect(githubSlug("https://gitlab.com/acme/widget.git")).toBeUndefined();
	});
});

it("runs one worker per 8 GB, between 1 and 4", () => {
	expect(defaultWaveCap(4 * 1024 ** 3)).toBe(1);
	expect(defaultWaveCap(24 * 1024 ** 3)).toBe(3);
	expect(defaultWaveCap(128 * 1024 ** 3)).toBe(4);
});

describe("detect", () => {
	it("takes the tracker from the remote and the checks from package.json", async () => {
		const dir = repoDir({ lint: "x", test: "y", build: "z" });
		const d = await detect(dir, gitFor("git@github.com:acme/widget.git"), {});
		expect(d.answers.tracker).toEqual({ kind: "github", repo: "acme/widget" });
		expect(d.answers.checks).toEqual(["bun run lint", "bun run test"]);
		expect(d.scripts).toContain("bun run build");
	});
	it("picks Jira when JIRA_BASE_URL is set, keeping the GitHub repo for later", async () => {
		const dir = repoDir();
		const d = await detect(dir, gitFor("git@github.com:acme/widget.git"), {
			JIRA_BASE_URL: "https://acme.atlassian.net",
		});
		expect(d.answers.tracker).toEqual({ kind: "jira" });
		expect(d.answers.transitions).toEqual(JIRA_TRANSITIONS);
		expect(d.githubRepo).toBe("acme/widget");
	});
});

it("switching tracker without naming statuses takes that tracker's defaults", async () => {
	const d = await detect(repoDir(), gitFor("git@github.com:a/b.git"), {});
	const a = mergeAnswers(d.answers, { tracker: { kind: "jira" } });
	expect(a.transitions).toEqual(JIRA_TRANSITIONS);
});

it("renders a profile that validates", async () => {
	const dir = repoDir({ test: "y" });
	const d = await detect(dir, gitFor("git@github.com:acme/widget.git"), {});
	const file = join(dir, "portia.config.ts");
	writeFileSync(file, renderProfile(d.answers, dir));
	const p = await loadProfileFile(file);
	expect(p.gates.exit.map((s) => s.cmd)).toEqual(["bun run test"]);
	expect(p.allowedIncidental).toEqual(["bun.lock"]);
});

describe("portia init", () => {
	const cwd = process.cwd();
	afterEach(() => {
		process.chdir(cwd);
		vi.unstubAllEnvs();
	});
	const capture = () => {
		const out: string[] = [];
		const err: string[] = [];
		return {
			io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
			out,
			err,
		};
	};
	const inRepo = () => {
		const dir = repoDir({ test: "y" });
		vi.stubEnv("PORTIA_PROFILES_DIR", join(dir, "profiles"));
		vi.stubEnv("JIRA_BASE_URL", "");
		process.chdir(dir);
		return dir;
	};

	it("--detect prints the defaults and writes nothing", async () => {
		const dir = inRepo();
		const c = capture();
		expect(await runCli(["init", "--detect"], c.io)).toBe(EXIT.OK);
		const json = JSON.parse(c.out.join(""));
		expect(json.answers.checks).toEqual(["bun run test"]);
		expect(json.files.repo).toBe(join(process.cwd(), "portia.config.ts"));
		expect(existsSync(join(dir, "profiles"))).toBe(false);
	});

	it("--yes --answers writes a valid profile, and refuses to replace it without --force", async () => {
		const dir = inRepo();
		const answers = join(dir, "a.json");
		writeFileSync(answers, JSON.stringify({ saveTo: "repo", waveCap: 2 }));
		expect(
			await runCli(["init", "--yes", "--answers", answers], capture().io),
		).toBe(EXIT.OK);
		const file = join(process.cwd(), "portia.config.ts");
		expect((await loadProfileFile(file)).waveCap).toBe(2);
		expect(readFileSync(file, "utf8")).toContain("written by `portia init`");

		const again = capture();
		expect(
			await runCli(["init", "--yes", "--answers", answers], again.io),
		).toBe(EXIT.PROBLEM);
		expect(again.err.join()).toContain("--force");
		expect(
			await runCli(
				["init", "--yes", "--answers", answers, "--force"],
				capture().io,
			),
		).toBe(EXIT.OK);
	});

	it("refuses to interview without a terminal", async () => {
		inRepo();
		Object.defineProperty(process.stdin, "isTTY", {
			value: false,
			configurable: true,
		});
		const c = capture();
		expect(await runCli(["init"], c.io)).toBe(EXIT.PROBLEM);
		expect(c.err.join()).toContain("--yes");
	});
});
