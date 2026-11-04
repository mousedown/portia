import { existsSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import type { Exec } from "../core/exec";
import { repoNameFromCommonDir } from "../core/profile-file";

/** Everything `portia init` asks about; the rest of the profile takes fixed defaults. */
export interface Answers {
	repo: string;
	tracker: { kind: "github"; repo: string } | { kind: "jira" };
	/** Tracker status names (Jira) or label suffixes (GitHub). */
	transitions: { running: string; landed: string };
	/** Commands that must exit 0, from the repo root, before a child lands. */
	checks: string[];
	waveCap: number;
	models: { high: string; standard: string };
	branchPrefix: string;
	/** home: ~/.portia/profiles/<repo>.ts, just you. repo: portia.config.ts, shared with the team. */
	saveTo: "home" | "repo";
}

export interface Detected {
	answers: Answers;
	/** Every package.json script as the command that runs it, for picking checks. */
	scripts: string[];
	/** The origin's owner/name on GitHub, even when the tracker detected is Jira. */
	githubRepo?: string;
}

const GITHUB_SLUG = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const CHECK_SCRIPTS = [
	"lint",
	"typecheck",
	"type-check",
	"check-types",
	"test",
];
const LOCKFILES = [
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"yarn.lock",
	"package-lock.json",
];

export const GITHUB_TRANSITIONS = { running: "running", landed: "landed" };
export const JIRA_TRANSITIONS = { running: "In Progress", landed: "Done" };

export function githubSlug(remoteUrl: string): string | undefined {
	return GITHUB_SLUG.exec(remoteUrl.trim())?.[1];
}

function runner(root: string): string {
	if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
		return "bun run";
	if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(root, "yarn.lock"))) return "yarn";
	return "npm run";
}

/** Workers at once: one per 8 GB of memory, between 1 and 4. */
export const defaultWaveCap = (bytes = totalmem()) =>
	Math.max(1, Math.min(4, Math.floor(bytes / 8 / 1024 ** 3)));

/** Sensible answers for the repository at `root`, read from git and package.json. */
export async function detect(
	root: string,
	exec: Exec,
	env: Record<string, string | undefined> = process.env,
): Promise<Detected> {
	const git = async (...args: string[]) => {
		const r = await exec("git", args, { cwd: root });
		return r.code === 0 ? r.stdout.trim() : "";
	};
	const commonDir = await git("rev-parse", "--git-common-dir");
	const repo = commonDir
		? repoNameFromCommonDir(join(root, commonDir))
		: root.split("/").pop() || "app";
	const slug = githubSlug(await git("remote", "get-url", "origin"));

	const pkgFile = join(root, "package.json");
	const names = existsSync(pkgFile)
		? Object.keys(
				(
					JSON.parse(readFileSync(pkgFile, "utf8")) as {
						scripts?: Record<string, string>;
					}
				).scripts ?? {},
			)
		: [];
	const run = runner(root);
	const scripts = names.map((n) => `${run} ${n}`);
	const checks = CHECK_SCRIPTS.filter((n) => names.includes(n)).map(
		(n) => `${run} ${n}`,
	);

	const jira = Boolean(env.JIRA_BASE_URL) || !slug;
	return {
		scripts,
		githubRepo: slug,
		answers: {
			repo,
			tracker: jira ? { kind: "jira" } : { kind: "github", repo: slug ?? "" },
			transitions: jira ? JIRA_TRANSITIONS : GITHUB_TRANSITIONS,
			checks,
			waveCap: defaultWaveCap(),
			models: { high: "opus", standard: "sonnet" },
			branchPrefix: "epic",
			saveTo: "home",
		},
	};
}

/** Answers from `--answers`, laid over the detected ones. */
export function mergeAnswers(base: Answers, over: Partial<Answers>): Answers {
	const merged = { ...base, ...over };
	// Switching tracker without naming statuses takes that tracker's defaults.
	if (
		over.tracker &&
		!over.transitions &&
		over.tracker.kind !== base.tracker.kind
	)
		merged.transitions =
			over.tracker.kind === "jira" ? JIRA_TRANSITIONS : GITHUB_TRANSITIONS;
	return merged;
}

const stepName = (cmd: string) =>
	cmd
		.split(/\s+/)
		.pop()
		?.replace(/[^\w-]/g, "") || "check";

/** The profile as a readable TypeScript module, so people can edit it later. */
export function renderProfile(a: Answers, root: string): string {
	const q = JSON.stringify;
	const steps = a.checks
		.map((c) => `\tstep(${q(stepName(c))}, ${q(c)}),`)
		.join("\n");
	const lockfiles = LOCKFILES.filter((f) => existsSync(join(root, f)));
	const tracker =
		a.tracker.kind === "github"
			? `{ kind: "github", repo: ${q(a.tracker.repo)} }`
			: `{ kind: "jira" }`;
	return `// Portia profile for ${a.repo}, written by \`portia init\`. Re-run it to change the
// answers, or edit this file: every option is described in docs/reference.md.

import { homedir } from "node:os";
import { join } from "node:path";

// A check: a shell command, run from the repo root, that must exit 0.
const step = (name: string, cmd: string) => ({
	name,
	cmd,
	heavy: true,
	cwd: "root" as const,
});
const checks = [
${steps}
];

export default {
	repo: ${q(a.repo)},
	branchPrefix: ${q(a.branchPrefix)},
	tracker: ${tracker},
	transitions: { running: ${q(a.transitions.running)}, landed: ${q(a.transitions.landed)} },
	gates: { task: checks, exit: checks, epic: checks },
	waveCap: ${a.waveCap},
	models: { high: ${q(a.models.high)}, standard: ${q(a.models.standard)} },
	packageDir: ".",
	worktreesDir: join(homedir(), ".portia", "worktrees"),
	minFreeMb: 0,
	ports: [3200, 3299],
	portEnv: ["PORT"],
	services: [],
	debt: [],
	allowedIncidental: ${q(lockfiles)},
	sensitiveGlobs: [],
	design: { pass: 0.02, fail: 0.1, personas: {} },
	secondVendor: "true",
	agentBrowser: "true",
	jev: { enabled: false },
	spend: { worker: 2_000_000, wave: 4_000_000, epic: 8_000_000 },
	maxRetries: 1,
	denyRules: ["Bash(gh pr merge*)", "Bash(git push*main*)"],
};
`;
}
