import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/main";
import { loadProfileFile } from "../../src/core/config";
import { EXIT } from "../../src/core/exit";
import {
	defaultWaveCap,
	detect,
	GITHUB_TRANSITIONS,
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
	const JIRA_ENV = { JIRA_BASE_URL: "https://acme.atlassian.net" };
	it("a GitHub origin alone is a clear answer, and says so", async () => {
		const d = await detect(
			repoDir(),
			gitFor("git@github.com:acme/widget.git"),
			{},
		);
		expect(d.trackerSignal).toEqual({
			choice: "github",
			ambiguous: false,
			reason: "origin is acme/widget",
		});
	});
	it("a machine-wide JIRA_BASE_URL does not beat this repository's GitHub origin: it is a conflict", async () => {
		const d = await detect(
			repoDir(),
			gitFor("git@github.com:acme/widget.git"),
			JIRA_ENV,
		);
		expect(d.answers.tracker).toEqual({ kind: "github", repo: "acme/widget" });
		expect(d.answers.transitions).toEqual(GITHUB_TRANSITIONS);
		expect(d.trackerSignal.ambiguous).toBe(true);
		expect(d.trackerSignal.reason).toContain("JIRA_BASE_URL");
	});
	it("JIRA_BASE_URL with no GitHub origin is a clear answer", async () => {
		const d = await detect(repoDir(), gitFor(""), JIRA_ENV);
		expect(d.answers.tracker).toEqual({ kind: "jira" });
		expect(d.answers.transitions).toEqual(JIRA_TRANSITIONS);
		expect(d.trackerSignal.ambiguous).toBe(false);
	});
	it("no signal at all is not presented as Jira", async () => {
		const d = await detect(repoDir(), gitFor("git@gitlab.com:a/b.git"), {});
		expect(d.answers.tracker).toEqual({ kind: "github", repo: "" });
		expect(d.trackerSignal).toMatchObject({ choice: null, ambiguous: true });
	});
	it("takes checks from the stack when there is no package.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-init-"));
		writeFileSync(join(dir, "go.mod"), "module x\n");
		const d = await detect(dir, gitFor("git@github.com:a/b.git"), {});
		expect(d.answers.checks).toEqual(["go test ./...", "go vet ./..."]);
		expect(d.candidates.map((c) => c.cmd)).toContain("go test ./...");
	});
	it("lands directly when the repository has no CI to wait for", async () => {
		const none = await detect(repoDir(), gitFor("git@github.com:a/b.git"), {});
		expect(none.answers.directLand).toEqual({ maxChildren: 4 });
		const dir = repoDir();
		mkdirSync(join(dir, ".github/workflows"), { recursive: true });
		writeFileSync(join(dir, ".github/workflows/ci.yml"), "");
		const ci = await detect(dir, gitFor("git@github.com:a/b.git"), {});
		expect(ci.answers.directLand).toBeUndefined();
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

it("renders a profile portia drive will accept", async () => {
	const dir = repoDir({ test: "y" });
	const d = await detect(dir, gitFor("git@github.com:acme/widget.git"), {});
	const file = join(dir, "portia.config.ts");
	writeFileSync(file, renderProfile(d.answers, dir));
	expect((await loadProfileFile(file)).workers.mode).toBe("detached");
});

it("renders directLand only when answered, and it validates", async () => {
	const dir = repoDir({ test: "y" });
	const d = await detect(dir, gitFor("git@github.com:acme/widget.git"), {});
	const file = join(dir, "portia.config.ts");
	writeFileSync(
		file,
		renderProfile({ ...d.answers, directLand: { maxChildren: 4 } }, dir),
	);
	expect((await loadProfileFile(file)).directLand?.maxChildren).toBe(4);
	const without = join(dir, "without.config.ts");
	writeFileSync(
		without,
		renderProfile({ ...d.answers, directLand: null }, dir),
	);
	expect((await loadProfileFile(without)).directLand).toBeUndefined();
});

it("names each step for what it runs, not its last argument", async () => {
	const dir = repoDir();
	const d = await detect(dir, gitFor("git@github.com:a/b.git"), {});
	const file = join(dir, "portia.config.ts");
	writeFileSync(
		file,
		renderProfile(
			{
				...d.answers,
				checks: [
					"go test ./...",
					"ruff check .",
					"make check",
					"xcodebuild test -scheme App",
					"tool --flag",
				],
			},
			dir,
		),
	);
	expect((await loadProfileFile(file)).gates.exit.map((s) => s.name)).toEqual([
		"test",
		"check",
		"check-2",
		"test-2",
		"tool",
	]);
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
	const inRepo = (remote: string | null = "git@github.com:acme/widget.git") => {
		const dir = repoDir({ test: "y" });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
		git("init", "-q");
		if (remote) git("remote", "add", "origin", remote);
		vi.stubEnv("PORTIA_PROFILES_DIR", join(dir, "profiles"));
		vi.stubEnv("JIRA_BASE_URL", "");
		vi.stubEnv("PORTIA_PROFILE", "");
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

	it("--yes refuses to guess the tracker when the signals conflict, and says how to answer", async () => {
		const dir = inRepo();
		vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net");
		const c = capture();
		expect(await runCli(["init", "--yes"], c.io)).toBe(EXIT.PROBLEM);
		expect(c.err.join()).toContain("tracker");
		expect(c.err.join()).toContain("--answers");

		const answers = join(dir, "a.json");
		writeFileSync(answers, JSON.stringify({ tracker: { kind: "jira" } }));
		expect(
			await runCli(["init", "--yes", "--answers", answers], capture().io),
		).toBe(EXIT.OK);
	});

	it("--yes refuses when there is no signal at all", async () => {
		inRepo(null);
		const c = capture();
		expect(await runCli(["init", "--yes"], c.io)).toBe(EXIT.PROBLEM);
		expect(c.err.join()).toContain("tracker");
	});

	it("a re-run keeps the tracker of the profile already there, despite a conflict", async () => {
		const dir = inRepo();
		const answers = join(dir, "a.json");
		writeFileSync(
			answers,
			JSON.stringify({
				tracker: { kind: "jira" },
				transitions: { running: "Doing", landed: "Shipped" },
			}),
		);
		expect(
			await runCli(["init", "--yes", "--answers", answers], capture().io),
		).toBe(EXIT.OK);

		vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net");
		const c = capture();
		expect(await runCli(["init", "--detect"], c.io)).toBe(EXIT.OK);
		const json = JSON.parse(c.out.join(""));
		expect(json.answers.tracker).toEqual({ kind: "jira" });
		expect(json.answers.transitions.landed).toBe("Shipped");
		expect(json.trackerSignal).toMatchObject({
			choice: "jira",
			ambiguous: false,
		});
	});

	it("validates the profile it just wrote on a re-run, not the one it read first", async () => {
		const dir = inRepo();
		expect(await runCli(["init", "--yes"], capture().io)).toBe(EXIT.OK);
		const answers = join(dir, "a.json");
		writeFileSync(answers, JSON.stringify({ waveCap: 0 }));
		const c = capture();
		expect(
			await runCli(["init", "--yes", "--force", "--answers", answers], c.io),
		).toBe(EXIT.PROBLEM);
		expect(c.err.join()).toContain("waveCap");
	});

	it("writes at the repository root when run from a subdirectory", async () => {
		const dir = inRepo();
		mkdirSync(join(dir, "src/deep"), { recursive: true });
		process.chdir(join(dir, "src/deep"));
		const c = capture();
		expect(await runCli(["init", "--detect"], c.io)).toBe(EXIT.OK);
		const json = JSON.parse(c.out.join(""));
		expect(json.files.repo).toBe(join(realpathSync(dir), "portia.config.ts"));
		expect(json.answers.checks).toEqual(["bun run test"]);
	});

	it("refuses outside a git repository", async () => {
		const dir = repoDir({ test: "y" });
		vi.stubEnv("PORTIA_PROFILES_DIR", join(dir, "profiles"));
		process.chdir(dir);
		const c = capture();
		expect(await runCli(["init", "--detect"], c.io)).toBe(EXIT.PROBLEM);
		expect(c.err.join()).toContain("git repository");
	});

	it("warns when PORTIA_PROFILE outranks the profile it just wrote", async () => {
		const dir = inRepo();
		vi.stubEnv("PORTIA_PROFILE", join(dir, "other.ts"));
		const c = capture();
		expect(await runCli(["init", "--yes"], c.io)).toBe(EXIT.OK);
		expect(c.err.join()).toContain("PORTIA_PROFILE");
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
