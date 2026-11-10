import { existsSync, readdirSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import type { Exec } from "../core/exec";
import { repoNameFromCommonDir } from "../core/profile-file";
import { type CheckCandidate, detectChecks, packageScripts } from "./stack";

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
	/** Land each child without a PR's CI wait, for a repository with no CI. null: wait for CI. */
	directLand?: { maxChildren: number } | null;
}

/** What the repository and machine say about the tracker, and how far to trust it. */
export interface TrackerSignal {
	/** null: nothing points either way, so answers.tracker is only a starting point. */
	choice: "github" | "jira" | null;
	/** The signals conflict or are absent: ask, and never take the answer silently. */
	ambiguous: boolean;
	/** The evidence, in words a person can check. */
	reason: string;
}

export interface Detected {
	answers: Answers;
	trackerSignal: TrackerSignal;
	/** Every package.json script as the command that runs it, for picking checks. */
	scripts: string[];
	/** Every command the repository gives evidence for, for picking checks. */
	candidates: CheckCandidate[];
	/** The origin's owner/name on GitHub, even when the tracker detected is Jira. */
	githubRepo?: string;
}

const GITHUB_SLUG = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
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

function trackerSignal(
	slug: string | undefined,
	jiraEnv: boolean,
): TrackerSignal {
	if (slug && jiraEnv)
		return {
			choice: "github",
			ambiguous: true,
			reason: `origin is ${slug}, but JIRA_BASE_URL is also set`,
		};
	if (slug)
		return { choice: "github", ambiguous: false, reason: `origin is ${slug}` };
	if (jiraEnv)
		return { choice: "jira", ambiguous: false, reason: "JIRA_BASE_URL is set" };
	return {
		choice: null,
		ambiguous: true,
		reason: "no GitHub origin and no JIRA_BASE_URL",
	};
}

const CI_FILES = [
	".circleci",
	".gitlab-ci.yml",
	".travis.yml",
	".buildkite",
	"azure-pipelines.yml",
	"Jenkinsfile",
];
const DIRECT_LAND_MAX = 4;

function hasCi(root: string): boolean {
	const workflows = join(root, ".github/workflows");
	if (existsSync(workflows) && readdirSync(workflows).length > 0) return true;
	return CI_FILES.some((f) => existsSync(join(root, f)));
}

/** Workers at once: one per 8 GB of memory, between 1 and 4. */
export const defaultWaveCap = (bytes = totalmem()) =>
	Math.max(1, Math.min(4, Math.floor(bytes / 8 / 1024 ** 3)));

/** Sensible answers for the repository at `root`, read from git and its files. */
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

	const candidates = detectChecks(root);
	const signal = trackerSignal(slug, Boolean(env.JIRA_BASE_URL));
	const jira = signal.choice === "jira";
	return {
		trackerSignal: signal,
		scripts: packageScripts(root),
		candidates,
		githubRepo: slug,
		answers: {
			repo,
			tracker: jira ? { kind: "jira" } : { kind: "github", repo: slug ?? "" },
			transitions: jira ? JIRA_TRANSITIONS : GITHUB_TRANSITIONS,
			checks: candidates.filter((c) => c.preselect).map((c) => c.cmd),
			waveCap: defaultWaveCap(),
			models: { high: "opus", standard: "sonnet" },
			branchPrefix: "epic",
			saveTo: "home",
			...(hasCi(root) ? {} : { directLand: { maxChildren: DIRECT_LAND_MAX } }),
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

/** Named for what it runs: `go test ./...` is test, `tool --flag` is tool. */
function stepName(cmd: string): string {
	const words = cmd.split(/\s+/);
	const flag = words.findIndex((w) => w.startsWith("-"));
	const name = (flag < 0 ? words : words.slice(0, flag))
		.filter((w) => /^\w[\w-]*$/.test(w))
		.pop();
	return name || "check";
}

/** Each check's step, numbering a name that repeats. */
function stepNames(cmds: string[]): string[] {
	const seen = new Map<string, number>();
	return cmds.map((c) => {
		const name = stepName(c);
		const n = (seen.get(name) ?? 0) + 1;
		seen.set(name, n);
		return n === 1 ? name : `${name}-${n}`;
	});
}

/** The profile as a readable TypeScript module, so people can edit it later. */
export function renderProfile(a: Answers, root: string): string {
	const q = JSON.stringify;
	const names = stepNames(a.checks);
	const steps = a.checks
		.map((c, i) => `\tstep(${q(names[i])}, ${q(c)}),`)
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
	// portia drive starts every worker itself, and refuses any other mode.
	workers: { mode: "detached" },${
		a.directLand
			? `
	// No CI was found to wait for, so a child lands on its gates alone. CI still runs on the
	// epic PR. An epic of more children than this needs CI on each child's PR.
	directLand: { maxChildren: ${a.directLand.maxChildren} },`
			: ""
	}
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
