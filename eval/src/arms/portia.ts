import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { git, gitOk } from "../metrics/git";
import { portiaMetrics } from "../metrics/portia";
import { portiaVersion } from "../metrics/version";
import type { Arm, ArmContext, ArmOutcome } from ".";
import { answeredSession, type Session, savedAnsweredSession } from "./claude";

/**
 * Portia as documented: `/portia KEY` in a headless Claude Code session, with the run's
 * state under an isolated Portia home so every attempt, gate, decision and token count is
 * in this run's own log. The scripted person's answers go in `person.json` beside the suite
 * (plan approval, spec sign-off, parked questions); the skill reads them through
 * PORTIA_EVAL_ANSWERS. The clean config directory every arm gets holds one skill here:
 * Portia's own, from the checkout the run records.
 */
export const portia: Arm = {
	name: "portia",
	description:
		"/portia KEY in a headless Claude Code session, with a scripted person answering plan approval, sign-off and parked questions.",
	async run(ctx) {
		// Before any session: a run with no profile for this repo never spends a token.
		const home = join(ctx.artifacts, "portia-home");
		const env = portiaEnv(home, ctx.person, ctx.repo.name);
		mkdirSync(home, { recursive: true });
		env.PORTIA_PROFILE = writeRunProfile(
			ctx.artifacts,
			env.PORTIA_PROFILE as string,
			runPrefix(ctx.artifacts),
		);
		const checkout =
			(await portiaVersion()).checkout ??
			fail("no Portia checkout: set PORTIA_CHECKOUT or link the portia binary");
		await pushTo(ctx.clone, ctx.repo.remote, ctx.log);
		const token = workerToken(ctx.artifacts);
		if (token) env.PORTIA_WORKER_TOKEN_FILE = token;
		try {
			const { session: s, answers } = await answeredSession(ctx, {
				cwd: ctx.clone,
				prompt: `/portia ${ctx.epic.key}`,
				name: "orchestrator",
				skills: [join(checkout, "skills", "portia")],
				env,
			});
			return portiaOutcome(ctx, s, answers);
		} finally {
			if (token) rmSync(token, { force: true });
		}
	},
	async rebuild(ctx) {
		const saved =
			savedAnsweredSession(ctx.artifacts, "orchestrator", ctx.limits.minutes) ??
			fail(`no orchestrator.json in ${ctx.artifacts}: nothing to rebuild`);
		return portiaOutcome(ctx, saved.session, saved.answers);
	},
};

/**
 * What a Portia run delivered, from the orchestrator session and what Portia left behind:
 * its integration branch and children's branches in the clone, and its run log in the
 * isolated home. The same whether the session just ran or is read back from disk.
 */
async function portiaOutcome(
	ctx: ArmContext,
	s: Session,
	answers: number,
): Promise<ArmOutcome> {
	const branch = await scoredBranch(
		ctx.clone,
		ctx.epic.key,
		savedPrefix(ctx.artifacts),
		ctx.repo.remote,
		ctx.repo.main,
	);
	const log = join(
		ctx.artifacts,
		"portia-home",
		"runs",
		ctx.epic.key,
		"runlog.jsonl",
	);
	const m = existsSync(log)
		? portiaMetrics(readFileSync(log, "utf8"), ctx.epic.children)
		: undefined;
	return {
		exitCode: s.exitCode,
		stoppedBy: s.stoppedBy,
		branch,
		branchesToMerge: 1,
		childBranches: await childBranches(
			ctx.clone,
			branch,
			ctx.epic.key,
			ctx.epic.children.map((c) => c.key),
		),
		partial: {
			cost: {
				tokens: m?.tokens ?? s.tokens,
				tokensByModel: m?.tokensByModel ?? s.tokensByModel,
				// The orchestrator's session plus every detached worker, each its own process and bill.
				usd:
					s.usd === undefined
						? undefined
						: s.usd +
							workersUsd(
								join(ctx.artifacts, "portia-home", "runs", ctx.epic.key),
							),
				wallMinutes: s.minutes,
				workMinutes: m?.workMinutes ?? s.minutes,
			},
			rework: m?.rework,
			// Questions the orchestrator put to the person outside Portia's own scripted moments.
			human: m?.human
				? { ...m.human, decisions: m.human.decisions + answers }
				: { decisions: answers, waitingMinutes: 0 },
			safety: m?.safety,
		},
	};
}

/**
 * The branch to score: Portia's integration branch, <the run's prefix>/<KEY> (or epic/<KEY> for
 * a run before it had one). Portia lands each child by merging its pull request on the
 * tracker's repo, so the clone's own copy of the branch is stale: with a remote, the pushed
 * branches are fetched first and the pushed tip wins.
 */
export async function scoredBranch(
	clone: string,
	key: string,
	prefix: string | undefined,
	remote: string | undefined,
	main: string,
): Promise<string> {
	if (remote && prefix)
		await gitOk(clone, [
			"fetch",
			"--quiet",
			"origin",
			`+refs/heads/${prefix}/*:refs/remotes/origin/${prefix}/*`,
		]);
	return (await branchFor(clone, key, prefix)) ?? main;
}

/**
 * What Portia's detached workers spent: each runs as its own `claude` process, outside the
 * orchestrator's session and so outside its cost, and logs its own result lines.
 */
export function workersUsd(runDir: string): number {
	if (!existsSync(runDir)) return 0;
	let usd = 0;
	for (const f of readdirSync(runDir))
		if (/^worker-.+\.log$/.test(f))
			for (const line of readFileSync(join(runDir, f), "utf8").split("\n")) {
				if (!line.includes('"type":"result"')) continue;
				try {
					const cost = JSON.parse(line).total_cost_usd;
					if (typeof cost === "number") usd += cost;
				} catch {}
			}
	return usd;
}

async function branchFor(
	clone: string,
	key: string,
	prefix?: string,
): Promise<string | undefined> {
	for (const b of [
		...(prefix ? [`origin/${prefix}/${key}`, `${prefix}/${key}`] : []),
		`epic/${key}`,
		`portia/${key}`,
	])
		if (await gitOk(clone, ["rev-parse", "--verify", b])) return b;
	const out = await git(clone, ["branch", "--list", `*${key}*`]);
	return out
		.split("\n")
		.map((l) => l.replace("*", "").trim())
		.find(Boolean);
}

/**
 * Each child's own branch, beside the integration branch under the same prefix
 * (`<prefix>/<CHILD>`), locally or as pushed. A child with neither is left out.
 */
export async function childBranches(
	clone: string,
	integration: string,
	parent: string,
	keys: string[],
): Promise<string[]> {
	if (!integration.endsWith(`/${parent}`)) return [];
	const prefix = integration.slice(0, -parent.length - 1);
	const out: string[] = [];
	for (const key of keys)
		for (const b of [`${prefix}/${key}`, `origin/${prefix}/${key}`])
			if (await gitOk(clone, ["rev-parse", "--verify", "--quiet", b])) {
				out.push(b);
				break;
			}
	return out;
}

/** Where a run keeps the branch prefix its profile was given, for scoring and rescore. */
const PREFIX_FILE = "portia-prefix";

/**
 * A branch prefix no other run has: every run's branches, and so its pull requests, are its
 * own. GitHub keeps merged pull requests for good, and Portia takes a child whose branch has
 * a merged pull request as already landed, so a prefix one run shared with the next would
 * hand the next run the last one's work.
 */
export function runPrefix(artifacts: string, now = Date.now()): string {
	return `eval-r${basename(artifacts)}-${now.toString(36)}`;
}

/**
 * The operator's profile with only what keeps runs apart changed: the run's own branch
 * prefix, and worktrees inside the run's artifacts instead of the operator's.
 */
export function writeRunProfile(
	artifacts: string,
	base: string,
	prefix: string,
): string {
	const file = join(artifacts, "portia-profile.ts");
	writeFileSync(
		file,
		`import base from ${JSON.stringify(base)};\n\nexport default {\n\t...base,\n\tbranchPrefix: ${JSON.stringify(prefix)},\n\tworktreesDir: ${JSON.stringify(join(artifacts, "worktrees"))},\n};\n`,
	);
	writeFileSync(join(artifacts, PREFIX_FILE), prefix);
	return file;
}

const savedPrefix = (artifacts: string): string | undefined => {
	const f = join(artifacts, PREFIX_FILE);
	return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
};

/** Where the operator's Portia profile for `repo` is: `<PORTIA_PROFILES_DIR>/<repo>.ts`. */
export function profileFor(
	repo: string,
	env: Record<string, string | undefined> = process.env,
): { profiles: string; profile: string } {
	const profiles = resolve(
		env.PORTIA_PROFILES_DIR ??
			join(env.PORTIA_HOME ?? join(homedir(), ".portia"), "profiles"),
	);
	return { profiles, profile: join(profiles, `${repo}.ts`) };
}

/**
 * Run state goes to the isolated home and the answers come from the scripted person. The
 * repo's profile is still read from the operator's profiles, as `portia --dry-run` does, but
 * named outright: Portia finds a profile by the checkout folder's name, and the clone's
 * folder is `clone`, not the repo's.
 */
/**
 * The run's login, for the detached workers Portia starts. A clean config holds no stored
 * login, so sessions authenticate with CLAUDE_CODE_OAUTH_TOKEN; Claude Code strips that from
 * the commands its shell tool runs, so a worker the orchestrator starts would never see it.
 * The token goes in an owner-only file the run deletes after, and Portia passes it on.
 */
export function workerToken(
	artifacts: string,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const token = env.CLAUDE_CODE_OAUTH_TOKEN;
	if (!token) return undefined;
	const file = join(artifacts, "worker-token");
	writeFileSync(file, token, { mode: 0o600 });
	return file;
}

export function portiaEnv(
	home: string,
	answers: string,
	repo: string,
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const { profiles, profile } = profileFor(repo, env);
	if (!existsSync(profile))
		fail(
			`no Portia profile for ${repo}: expected ${profile} (set PORTIA_PROFILES_DIR, or run /portia-setup in the repo)`,
		);
	return {
		PORTIA_HOME: home,
		PORTIA_EVAL_ANSWERS: answers,
		PORTIA_PROFILES_DIR: profiles,
		PORTIA_PROFILE: profile,
	};
}

/**
 * Points the clone's origin at the tracker's repo, so Portia's pushes and pull requests land
 * where the tracker can see them. The branches stay in the clone too, which is what scoring
 * reads. Without a remote, origin stays the suite's source.
 */
export async function pushTo(
	clone: string,
	remote: string | undefined,
	log: (line: string) => void = () => {},
): Promise<void> {
	if (!remote) return;
	await git(clone, ["remote", "set-url", "origin", remote]);
	log(`origin: ${remote}`);
}

function fail(message: string): never {
	throw new Error(message);
}
