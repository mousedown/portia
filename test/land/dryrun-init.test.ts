import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { dryRun } from "../../src/core/exec";
import {
	initIntegration,
	integrationWorktree,
} from "../../src/land/integration-and-land";
import { hybridExec, sandbox } from "../helpers/git-sandbox";
import { parent, spine } from "../helpers/plan";

const saved = process.env.PORTIA_DRY_RUN;
afterEach(() => {
	if (saved === undefined) delete process.env.PORTIA_DRY_RUN;
	else process.env.PORTIA_DRY_RUN = saved;
});

it("a dry-run integration init on a fresh parent logs the push and PR, and changes nothing", async () => {
	// The sandbox's own commit and push must happen for real: origin/main exists in any real repo.
	const s = await sandbox();
	process.env.PORTIA_DRY_RUN = "1";
	const profile = { ...testProfile(), worktreesDir: join(s.root, "wt") };
	const logged: string[] = [];
	const { exec } = hybridExec((a) => (a[1] === "list" ? { stdout: "[]" } : {}));
	const plan = parent([spine()]);
	const { epicPr } = await initIntegration({
		exec: dryRun(exec, (l) => logged.push(l)),
		profile,
		repoRoot: s.repo,
		dir: mkdtempSync(join(s.root, "run-")),
		plan,
		tracker: { transition: async () => {} },
		gate: async () => ({ kind: "exit", ok: true, steps: [] }),
	});
	expect(epicPr).toBe(1);
	expect(logged.some((l) => l.startsWith("[dry-run] git push origin"))).toBe(
		true,
	);
	expect(logged.some((l) => l.startsWith("[dry-run] gh pr create"))).toBe(true);
	expect(await s.g(s.repo, "ls-remote", "origin", "portia/ACME-0")).toBe("");
	expect(existsSync(integrationWorktree(profile, "ACME-0"))).toBe(false);
});
