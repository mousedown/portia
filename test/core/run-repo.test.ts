import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PortiaProblem } from "../../src/core/exit";
import { RUN_REPO_FILE, repoOfRecords } from "../../src/core/run-repo";
import { runDir, runPath, setRunOwner } from "../../src/core/rundir";

let home = "";
const env = () => ({ PORTIA_HOME: home });
const owner = (repo: string) => ({ repo, worktreesDir: "/wt" });

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "portia-run-repo-"));
});
afterEach(() => setRunOwner(undefined));

it("the first repository to open a run owns it", () => {
	setRunOwner(owner("shop-ios"));
	const dir = runDir("GH-1", env());
	expect(JSON.parse(readFileSync(join(dir, RUN_REPO_FILE), "utf8"))).toEqual({
		repo: "shop-ios",
	});
	expect(runDir("GH-1", env())).toBe(dir);
});
it("refuses a run another repository owns, naming both and writing nothing", () => {
	setRunOwner(owner("shop-ios"));
	const dir = runDir("GH-1", env());
	setRunOwner(owner("portia"));
	expect(() => runDir("GH-1", env())).toThrow(PortiaProblem);
	expect(() => runDir("GH-1", env())).toThrow(/GH-1.*shop-ios.*portia/s);
	expect(JSON.parse(readFileSync(join(dir, RUN_REPO_FILE), "utf8")).repo).toBe(
		"shop-ios",
	);
});
it("reads an older run's owner from where its worktrees live, so a colliding key cannot claim it", () => {
	const dir = runPath("GH-1", env());
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "env-GH-2.json"),
		JSON.stringify({ worktree: "/wt/shop-ios/GH-2" }),
	);
	setRunOwner(owner("portia"));
	expect(() => runDir("GH-1", env())).toThrow(/shop-ios/);
	setRunOwner(owner("shop-ios"));
	runDir("GH-1", env());
	expect(JSON.parse(readFileSync(join(dir, RUN_REPO_FILE), "utf8")).repo).toBe(
		"shop-ios",
	);
});
it("does not guess an owner from a worktree outside the profile's worktrees", () => {
	const dir = runPath("GH-1", env());
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "worker-GH-2.json"),
		JSON.stringify({ worktree: "/elsewhere/other/GH-2" }),
	);
	setRunOwner(owner("portia"));
	expect(runDir("GH-1", env())).toBe(dir);
});
it("checks nothing without an owner, as for a command that has no profile", () => {
	setRunOwner(owner("shop-ios"));
	runDir("GH-1", env());
	setRunOwner(undefined);
	expect(() => runDir("GH-1", env())).not.toThrow();
});
it("repoOfRecords names the repository from a record's worktree, skipping what it cannot read", () => {
	expect(
		repoOfRecords(["not json", undefined, '{"worktree":"/wt/acme-app/A-1"}']),
	).toBe("acme-app");
	expect(repoOfRecords(["{}"])).toBeUndefined();
});
