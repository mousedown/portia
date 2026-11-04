import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import type { Exec } from "../../src/core/exec";
import { initIntegration } from "../../src/land/integration-and-land";
import { hybridExec, sandbox } from "../helpers/git-sandbox";
import { parent, spine } from "../helpers/plan";

const run = async (withPackageJson: boolean) => {
	const s = await sandbox();
	if (withPackageJson) {
		writeFileSync(join(s.repo, "package.json"), "{}\n");
		await s.g(s.repo, "add", ".");
		await s.g(s.repo, "commit", "-m", "pkg");
		await s.g(s.repo, "push", "origin", "HEAD:main");
	}
	const inner = hybridExec((args) =>
		args[1] === "list"
			? { stdout: "[]" }
			: args[1] === "create"
				? { stdout: "https://github.com/o/r/pull/42\n" }
				: {},
	);
	const installs: string[] = [];
	const exec: Exec = async (cmd, args, opts) => {
		if (cmd === "bun") {
			installs.push(opts?.cwd ?? "");
			return { code: 0, stdout: "", stderr: "" };
		}
		return inner.exec(cmd, args, opts);
	};
	const profile = { ...testProfile(), worktreesDir: join(s.root, "wt") };
	await initIntegration({
		exec,
		profile,
		repoRoot: s.repo,
		dir: mkdtempSync(join(s.root, "run-")),
		plan: parent([spine()]),
		tracker: { transition: async () => {} },
		gate: async () => ({ kind: "exit", ok: true, steps: [] }),
	});
	return { installs, wt: join(profile.worktreesDir, profile.repo, "ACME-0") };
};

it("installs dependencies in a freshly created integration worktree", async () => {
	const r = await run(true);
	expect(r.installs).toEqual([r.wt]);
});

it("skips the install when the worktree has no package.json", async () => {
	expect((await run(false)).installs).toEqual([]);
});
