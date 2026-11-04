import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { realExec } from "../../src/core/exec";
import { touchedFiles } from "../../src/gate/touched";
import { sandbox } from "../helpers/git-sandbox";

it("unions committed, uncommitted tracked and untracked files, deduped", async () => {
	const { repo, g } = await sandbox();
	await g(repo, "push", "origin", "HEAD:portia/ACME-1");
	await g(repo, "fetch", "origin");
	writeFileSync(join(repo, "committed.txt"), "c\n");
	await g(repo, "add", ".");
	await g(repo, "commit", "-m", "c");
	writeFileSync(join(repo, "a.txt"), "changed\n");
	writeFileSync(join(repo, "untracked.txt"), "u\n");
	const files = await touchedFiles(realExec, testProfile(), repo, "ACME-1");
	expect(files.sort()).toEqual(["a.txt", "committed.txt", "untracked.txt"]);
});

it("compares against a pinned base when given one, so a moved parent branch adds nothing", async () => {
	const { repo, g } = await sandbox();
	await g(repo, "push", "origin", "HEAD:portia/ACME-1");
	await g(repo, "fetch", "origin");
	const onto = (await g(repo, "rev-parse", "HEAD")).trim();
	writeFileSync(join(repo, "mine.txt"), "m\n");
	await g(repo, "add", ".");
	await g(repo, "commit", "-m", "mine");
	// A sibling lands and its fetch moves origin/portia/ACME-1 past this child's base.
	await g(repo, "checkout", "-q", "-b", "sibling", onto);
	writeFileSync(join(repo, "theirs.txt"), "t\n");
	await g(repo, "add", ".");
	await g(repo, "commit", "-m", "theirs");
	await g(repo, "push", "origin", "HEAD:portia/ACME-1");
	await g(repo, "fetch", "origin");
	await g(repo, "checkout", "-q", "-");
	expect(
		await touchedFiles(realExec, testProfile(), repo, "ACME-1", onto),
	).toEqual(["mine.txt"]);
	expect(
		(await touchedFiles(realExec, testProfile(), repo, "ACME-1")).sort(),
	).toEqual(["mine.txt", "theirs.txt"]);
});
