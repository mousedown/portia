import { homedir } from "node:os";
import { join } from "node:path";

const step = (name: string, cmd: string) => ({
	name,
	cmd,
	heavy: true,
	cwd: "root" as const,
});

/** Portia's profile for this repository: no database, no services, `bun test` as every gate. */
export default {
	repo: "portia-fixture",
	branchPrefix: "epic",
	tracker: { kind: "github", repo: "mousedown/portia-fixture" },
	packageDir: ".",
	// PORTIA_WORKTREES lets a test keep worktrees inside its own temp directory.
	worktreesDir:
		process.env.PORTIA_WORKTREES ?? join(homedir(), ".portia", "worktrees"),
	waveCap: 2,
	minFreeMb: 0,
	ports: [3200, 3299],
	portEnv: ["PORT"],
	services: [],
	debt: [],
	models: { high: "opus", standard: "sonnet" },
	transitions: { running: "running", landed: "landed" },
	gates: {
		task: [step("test", "bun test")],
		exit: [step("test", "bun test")],
		epic: [
			step("test", "bun test"),
			step("acceptance", "bun test {acceptance}"),
		],
	},
	allowedIncidental: [],
	sensitiveGlobs: [],
	design: { pass: 0.02, fail: 0.1, personas: {} },
	// Nothing to browse and no second reviewer here; both steps are required, so they pass.
	secondVendor: "true",
	agentBrowser: "true",
	jev: { enabled: false },
	spend: { worker: 2_000_000, wave: 4_000_000, epic: 8_000_000 },
	maxRetries: 1,
	denyRules: ["Bash(gh pr merge*)", "Bash(git push*main*)"],
};
