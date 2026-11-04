import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProfile } from "../../src/core/config";
import { PortiaProblem } from "../../src/core/exit";
import {
	findProfileFile,
	locateProfile,
	profilesHome,
	repoNameFromCommonDir,
} from "../../src/core/profile-file";
import acme from "../fixtures/profile";

const repo = (file?: string) => {
	const root = mkdtempSync(join(tmpdir(), "portia-profile-"));
	if (file !== undefined) writeFileSync(join(root, "portia.config.ts"), file);
	return root;
};
const validSource = `export default ${JSON.stringify(acme)};\n`;

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.PORTIA_PROFILE;
	delete process.env.PORTIA_PROFILE;
});
afterEach(() => {
	if (saved === undefined) delete process.env.PORTIA_PROFILE;
	else process.env.PORTIA_PROFILE = saved;
});

it("loads a valid portia.config.ts from the repo root", async () => {
	const p = await loadProfile(repo(validSource));
	expect(p.repo).toBe("acme-web");
	expect(p.gates.task.length).toBeGreaterThan(0);
});

it("a missing file is a PortiaProblem naming the root", async () => {
	const root = repo();
	expect(() => findProfileFile(root)).toThrow(PortiaProblem);
	await expect(loadProfile(root)).rejects.toThrow(
		`no portia.config.ts in ${root}`,
	);
	await expect(loadProfile(root)).rejects.toThrow("PORTIA_PROFILE is not set");
});

it("a file that throws on import is a PortiaProblem naming the file", async () => {
	const root = repo(`throw new Error("boom");\n`);
	const err = await loadProfile(root).catch((e) => e);
	expect(err).toBeInstanceOf(PortiaProblem);
	expect(err.message).toContain(join(root, "portia.config.ts"));
	expect(err.message).toContain("boom");
});

it("a schema failure is a PortiaProblem naming the file and the field", async () => {
	const bad = { ...acme, waveCap: "three" };
	const root = repo(`export default ${JSON.stringify(bad)};\n`);
	const err = await loadProfile(root).catch((e) => e);
	expect(err).toBeInstanceOf(PortiaProblem);
	expect(err.message).toContain(join(root, "portia.config.ts"));
	expect(err.message).toContain("waveCap");
});

it("a file without a default export is a PortiaProblem", async () => {
	const root = repo(`export const x = 1;\n`);
	await expect(loadProfile(root)).rejects.toThrow(PortiaProblem);
});

it("PORTIA_PROFILE overrides the repo-root lookup", async () => {
	const other = mkdtempSync(join(tmpdir(), "portia-profile-env-"));
	mkdirSync(join(other, "sub"));
	const file = join(other, "sub", "mine.ts");
	writeFileSync(file, validSource);
	process.env.PORTIA_PROFILE = file;
	expect(findProfileFile(repo())).toBe(file);
	expect((await loadProfile(repo())).repo).toBe("acme-web");
});

it("PORTIA_PROFILE pointing at nothing is a PortiaProblem naming it", () => {
	process.env.PORTIA_PROFILE = "/nonexistent/p.ts";
	expect(() => findProfileFile(repo())).toThrow("/nonexistent/p.ts");
});

it("a relative PORTIA_PROFILE is a PortiaProblem", () => {
	process.env.PORTIA_PROFILE = "profiles/acme-web.ts";
	expect(() => findProfileFile(repo())).toThrow(
		"PORTIA_PROFILE must be an absolute path",
	);
});

it("a tracker keyPrefix must look like a ticket prefix and not be EXT", async () => {
	for (const keyPrefix of ["gh", "G", "1X", "EXT"]) {
		const bad = {
			...acme,
			tracker: { kind: "github", repo: "o/r", keyPrefix },
		};
		const root = repo(`export default ${JSON.stringify(bad)};\n`);
		const err = await loadProfile(root).catch((e) => e);
		expect(err).toBeInstanceOf(PortiaProblem);
		expect(err.message).toContain("keyPrefix");
	}
	const good = {
		...acme,
		tracker: { kind: "github", repo: "o/r", keyPrefix: "GH" },
	};
	expect(
		(await loadProfile(repo(`export default ${JSON.stringify(good)};\n`)))
			.tracker,
	).toMatchObject({ keyPrefix: "GH" });
});

it("a github tracker's keys are number or title, and unset by default", async () => {
	const load = (tracker: unknown) =>
		loadProfile(
			repo(`export default ${JSON.stringify({ ...acme, tracker })};\n`),
		);
	expect(
		(await load({ kind: "github", repo: "o/r", keys: "title" })).tracker,
	).toMatchObject({ keys: "title" });
	expect(
		(await load({ kind: "github", repo: "o/r" })).tracker,
	).not.toHaveProperty("keys");
	const err = await load({ kind: "github", repo: "o/r", keys: "body" }).catch(
		(e) => e,
	);
	expect(err).toBeInstanceOf(PortiaProblem);
	expect(err.message).toContain("keys");
});

describe("the user's profiles in ~/.portia/profiles", () => {
	const mine = () => {
		const dir = mkdtempSync(join(tmpdir(), "portia-profiles-"));
		writeFileSync(join(dir, "acme-web.ts"), validSource);
		return dir;
	};

	it("falls back to <profiles>/<repo name>.ts", () => {
		const profilesDir = mine();
		const root = repo();
		expect(locateProfile(root, { repoName: "acme-web", profilesDir })).toEqual({
			file: join(profilesDir, "acme-web.ts"),
			via: "home",
		});
	});

	it("names the repo after the root's folder when no name is given", () => {
		const profilesDir = mine();
		const parent = mkdtempSync(join(tmpdir(), "portia-root-"));
		const root = join(parent, "acme-web");
		mkdirSync(root);
		expect(locateProfile(root, { profilesDir }).via).toBe("home");
	});

	it("prefers portia.config.ts at the repo root", () => {
		const profilesDir = mine();
		const root = repo(validSource);
		expect(locateProfile(root, { repoName: "acme-web", profilesDir })).toEqual({
			file: join(root, "portia.config.ts"),
			via: "repo",
		});
	});

	it("prefers PORTIA_PROFILE over both", () => {
		const file = join(mine(), "acme-web.ts");
		process.env.PORTIA_PROFILE = file;
		expect(
			locateProfile(repo(validSource), {
				repoName: "acme-web",
				profilesDir: mine(),
			}),
		).toEqual({ file, via: "env" });
	});

	it("a miss names all three places it looked", () => {
		const profilesDir = mine();
		const root = repo();
		const err = (() => {
			try {
				locateProfile(root, { repoName: "other", profilesDir });
			} catch (e) {
				return e as Error;
			}
		})();
		expect(err).toBeInstanceOf(PortiaProblem);
		expect(err?.message).toContain("PORTIA_PROFILE");
		expect(err?.message).toContain(`no portia.config.ts in ${root}`);
		expect(err?.message).toContain(join(profilesDir, "other.ts"));
	});

	it("lives under PORTIA_HOME, which defaults to ~/.portia", () => {
		expect(profilesHome({ PORTIA_HOME: "/h" })).toBe(join("/h", "profiles"));
		expect(profilesHome({})).toBe(join(homedir(), ".portia", "profiles"));
		expect(
			profilesHome({ PORTIA_HOME: "/tmp/dry", PORTIA_PROFILES_DIR: "/h/p" }),
		).toBe("/h/p");
	});

	it("is found through PORTIA_HOME when no directory is passed", () => {
		const home = mkdtempSync(join(tmpdir(), "portia-home-"));
		mkdirSync(join(home, "profiles"));
		writeFileSync(join(home, "profiles", "acme-web.ts"), validSource);
		const saved = {
			h: process.env.PORTIA_HOME,
			d: process.env.PORTIA_PROFILES_DIR,
		};
		process.env.PORTIA_HOME = home;
		delete process.env.PORTIA_PROFILES_DIR;
		try {
			expect(locateProfile(repo(), { repoName: "acme-web" })).toEqual({
				file: join(home, "profiles", "acme-web.ts"),
				via: "home",
			});
		} finally {
			if (saved.h === undefined) delete process.env.PORTIA_HOME;
			else process.env.PORTIA_HOME = saved.h;
			if (saved.d !== undefined) process.env.PORTIA_PROFILES_DIR = saved.d;
		}
	});

	it("Portia ships no profiles of its own", () => {
		expect(existsSync(join(import.meta.dirname, "..", "..", "profiles"))).toBe(
			false,
		);
	});
});

describe("repoNameFromCommonDir", () => {
	it("is the main checkout's folder, whichever worktree asks", () => {
		expect(repoNameFromCommonDir("/Users/x/git/acme-web/.git\n")).toBe(
			"acme-web",
		);
	});
	it("strips .git from a bare repository", () => {
		expect(repoNameFromCommonDir("/srv/acme-web.git")).toBe("acme-web");
	});
	it("finds the same profile from a child worktree named after its key", async () => {
		const { execFileSync } = await import("node:child_process");
		const parent = mkdtempSync(join(tmpdir(), "portia-wt-"));
		const main = join(parent, "acme-web");
		mkdirSync(main);
		const git = (cwd: string, ...a: string[]) =>
			execFileSync("git", a, { cwd, encoding: "utf8" });
		git(main, "init", "-q");
		git(
			main,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		);
		const child = join(parent, "worktrees", "ACME-9");
		git(main, "worktree", "add", "-q", child);
		const common = git(
			child,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		);
		const profilesDir = mkdtempSync(join(tmpdir(), "portia-profiles-"));
		writeFileSync(join(profilesDir, "acme-web.ts"), validSource);
		expect(
			locateProfile(child, {
				repoName: repoNameFromCommonDir(common),
				profilesDir,
			}).file,
		).toBe(join(profilesDir, "acme-web.ts"));
	});
});
