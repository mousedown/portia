import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Exec, spawnExec } from "./arms/claude";
import { profileFor } from "./arms/portia";
import { type Epic, findEpic, type LoadedSuite, type Repo } from "./suite";

/**
 * `eval reset`: puts an epic's tracker back as `publish.sh` filed it, so a repeat run meets
 * the same tracker the first one did, not one a previous run planned. A Portia run writes a
 * ```plan block into each issue's body, labels the issues with its transitions, links
 * blockers between them, opens pull requests from `<branchPrefix>/<KEY>` branches and
 * leaves those branches pushed, and keeps a worktree per ticket under the profile's
 * `worktreesDir`. Each is undone here, only for the epic and its children: `main` and
 * `reference/*` are never touched. Everything goes through `gh`, so a test fakes it.
 */
export interface ResetStep {
	/** What it does, for the plan a dry run prints. */
	what: string;
	/** The command, `gh` or `git` first; empty for a note that does nothing. */
	cmd: string[];
}

/** What `reset` reads of the operator's Portia profile for the repo. */
export interface ResetProfile {
	branchPrefix: string;
	worktreesDir?: string;
}

interface Issue {
	id: number;
	number: number;
	title: string;
	state: string;
	body: string | null;
	labels: string[];
}

const PLAN_BLOCK = /^```plan\b/m;

/** `owner/name` of the suite repo's `remote` on GitHub. */
export function trackerRepo(repo: Repo): string {
	const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
		repo.remote ?? "",
	);
	if (!m?.[1])
		throw new Error(
			`suite repo ${repo.name} has no GitHub remote, so it has no tracker to reset`,
		);
	return m[1];
}

/** The issue as `publish.sh` files `<KEY>.md`: `<KEY>: <first line without "# ">`, the body from line 3. */
export function filed(
	key: string,
	text: string,
): { title: string; body: string } {
	const lines = text.split("\n");
	return {
		title: `${key}: ${(lines[0] ?? "").replace(/^# /, "")}`,
		// The shell's $(tail -n +3 file) drops every trailing newline.
		body: lines.slice(2).join("\n").replace(/\n+$/, ""),
	};
}

async function run(exec: Exec, cmd: string[]): Promise<string> {
	const r = await exec(cmd, { cwd: process.cwd(), env: ghEnv() });
	if (r.exitCode)
		throw new Error(`${cmd.join(" ")}: ${r.stderr.trim() || r.stdout}`);
	return r.stdout;
}
const gh = (exec: Exec, args: string[]) => run(exec, ["gh", ...args]);

const ghEnv = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => e[1] !== undefined,
		),
	);

const lines = (out: string) =>
	out
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));

/** Every issue on the tracker, pull requests left out. */
async function allIssues(exec: Exec, repo: string): Promise<Issue[]> {
	const all: (Issue & { pr: boolean })[] = lines(
		await gh(exec, [
			"api",
			"--paginate",
			`repos/${repo}/issues?state=all&per_page=100`,
			"--jq",
			".[] | {id, number, title, state, body, labels: [.labels[].name], pr: (.pull_request != null)}",
		]),
	);
	return all.filter((i) => !i.pr);
}

/** The epic's and its children's issues, by title key; a key not filed is left out. */
async function epicIssues(
	exec: Exec,
	repo: string,
	keys: string[],
	all?: Issue[],
): Promise<Map<string, Issue>> {
	const issues = all ?? (await allIssues(exec, repo));
	const out = new Map<string, Issue>();
	for (const k of keys) {
		const i = issues.find((x) => x.title.startsWith(`${k}: `));
		if (i) out.set(k, i);
	}
	return out;
}

const keysOf = (epic: Epic) => [epic.key, ...epic.children.map((c) => c.key)];

/** The prefix the Portia arm gives each run's branches (`runPrefix`). */
const RUN_PREFIX = /^eval-r[^/]+$/;

/**
 * Whether `name` is one of the epic's branches under the profile's prefix or a run's own:
 * `<prefix>/<KEY>`, or below it.
 */
const ownBranch = (name: string, prefix: string, keys: string[]) => {
	const at = name.indexOf("/");
	if (at < 0) return false;
	const head = name.slice(0, at);
	const rest = name.slice(at + 1);
	return (
		(head === prefix || RUN_PREFIX.test(head)) &&
		keys.some(
			(k) => rest === k || rest.startsWith(`${k}/`) || rest.startsWith(`${k}-`),
		)
	);
};

/** What a run-filed ticket's title starts with once reset retires it. */
const RUN_FILED = "[run-filed]";

/** A title's key, `ACME-405` from `ACME-405: Write the specs`. */
const titleKey = (title: string) => /^([A-Z][A-Z0-9]*-\d+): /.exec(title)?.[1];

/**
 * The epic's issues that still carry a ```plan block: a tracker an earlier run planned.
 * `eval run` refuses a Portia run on one, since Portia would resume that plan.
 */
export async function plannedIssues(
	repo: Repo,
	epic: Epic,
	exec: Exec = spawnExec,
): Promise<string[]> {
	const issues = await epicIssues(exec, trackerRepo(repo), keysOf(epic));
	return [...issues]
		.filter(([, i]) => PLAN_BLOCK.test(i.body ?? ""))
		.map(([k]) => k);
}

/** The operator's Portia profile for the repo, as the `portia` arm finds it. */
export async function loadProfile(
	repo: string,
	env: Record<string, string | undefined> = process.env,
): Promise<ResetProfile> {
	const { profile } = profileFor(repo, env);
	if (!existsSync(profile))
		throw new Error(`no Portia profile for ${repo}: expected ${profile}`);
	return (await import(profile)).default;
}

/** Every step that puts the epic's tracker back, in order. Reads only. */
export async function resetPlan(o: {
	suite: LoadedSuite;
	epicKey: string;
	profile: ResetProfile;
	tickets: Record<string, string>;
	exec?: Exec;
}): Promise<ResetStep[]> {
	const exec = o.exec ?? spawnExec;
	const { repo, epic } = findEpic(o.suite, o.epicKey);
	const r = trackerRepo(repo);
	const prefix = o.profile.branchPrefix;
	if (!prefix || prefix === repo.main || prefix === "reference")
		throw new Error(
			`branchPrefix ${JSON.stringify(prefix)} would reach ${repo.main} or reference/*`,
		);
	const keys = keysOf(epic);
	const all = await allIssues(exec, r);
	const issues = await epicIssues(exec, r, keys, all);
	const numbers = new Map([...issues].map(([k, i]) => [i.number, k]));
	const suiteKeys = new Set(
		o.suite.repos.flatMap((x) => x.epics.flatMap(keysOf)),
	);
	const project = epic.key.replace(/-\d+$/, "");
	/** A ticket a run filed itself: keyed like the epic's and in no epic of the suite, or already retitled. */
	const runFiled = (title: string) => {
		if (title.startsWith(`${RUN_FILED} `)) return true;
		const k = titleKey(title);
		return !!k && !suiteKeys.has(k) && k.startsWith(`${project}-`);
	};
	const filedByRuns = new Set(
		all.filter((i) => runFiled(i.title)).map((i) => i.number),
	);
	const steps: ResetStep[] = [];
	// Portia's transition labels, and the ones from before branchPrefix existed.
	const theirs = (l: string) =>
		l.startsWith(`${prefix}:`) || l.startsWith("portia:");

	for (const key of keys) {
		const i = issues.get(key);
		const text = o.tickets[key];
		if (!i || text === undefined) {
			steps.push({ what: `${key}: not filed, nothing to reset`, cmd: [] });
			continue;
		}
		const want = filed(key, text);
		const path = `repos/${r}/issues/${i.number}`;
		if (i.body !== want.body || i.title !== want.title)
			steps.push({
				what: `${key} (#${i.number}): restore the title and body to tickets/${key}.md${PLAN_BLOCK.test(i.body ?? "") ? ", dropping its plan block" : ""}`,
				cmd: [
					"gh",
					"api",
					path,
					"-X",
					"PATCH",
					"-f",
					`title=${want.title}`,
					"-f",
					`body=${want.body}`,
				],
			});
		if (i.state !== "open")
			steps.push({
				what: `${key} (#${i.number}): reopen`,
				cmd: ["gh", "api", path, "-X", "PATCH", "-f", "state=open"],
			});
		for (const l of i.labels.filter(theirs))
			steps.push({
				what: `${key} (#${i.number}): remove label ${l}`,
				cmd: [
					"gh",
					"api",
					"-X",
					"DELETE",
					`${path}/labels/${encodeURIComponent(l)}`,
				],
			});
		// publish.sh links no blockers, so any between the epic's issues came from a run.
		const blockers: { id: number; number: number }[] = lines(
			await gh(exec, [
				"api",
				"--paginate",
				`${path}/dependencies/blocked_by`,
				"--jq",
				".[] | {id, number}",
			]),
		);
		// A run-filed ticket left blocking a real one would be read as one of its needs, and its
		// retitled, keyless title stops the next run reading the epic at all.
		for (const b of blockers.filter(
			(b) => numbers.has(b.number) || filedByRuns.has(b.number),
		))
			steps.push({
				what: `${key} (#${i.number}): unlink blocker ${numbers.get(b.number) ?? "a run-filed ticket"} (#${b.number})`,
				cmd: [
					"gh",
					"api",
					"-X",
					"DELETE",
					`${path}/dependencies/blocked_by/${b.id}`,
				],
			});
	}

	// A ticket a run filed itself (Portia adds a spine ticket when the plan needs one): open,
	// keyed like the epic's, and in no epic of the suite. Closed as not planned and taken out
	// from under the epic, so the next run plans from the tickets as filed.
	const epicIssue = issues.get(epic.key);
	const created: string[] = [];
	for (const i of all) {
		const k = titleKey(i.title);
		if (!k || suiteKeys.has(k) || !k.startsWith(`${project}-`)) continue;
		created.push(k);
		// Portia resolves keys from titles, closed issues included, so a closed run ticket
		// would be found and reopened by the next run: its title loses the key.
		steps.push({
			what: `${k} (#${i.number}): retitle "${RUN_FILED} ${i.title}", so its key no longer resolves`,
			cmd: [
				"gh",
				"api",
				`repos/${r}/issues/${i.number}`,
				"-X",
				"PATCH",
				"-f",
				`title=${RUN_FILED} ${i.title}`,
			],
		});
		if (i.state !== "open") continue;
		if (epicIssue)
			steps.push({
				what: `${k} (#${i.number}): take it out from under ${epic.key} (#${epicIssue.number})`,
				cmd: [
					"gh",
					"api",
					"-X",
					"DELETE",
					`repos/${r}/issues/${epicIssue.number}/sub_issue`,
					"-F",
					`sub_issue_id=${i.id}`,
				],
			});
		steps.push({
			what: `${k} (#${i.number}): close as not planned (a run filed it; it is not a suite ticket)`,
			cmd: [
				"gh",
				"issue",
				"close",
				String(i.number),
				"--repo",
				r,
				"--reason",
				"not planned",
			],
		});
	}

	const prs: { number: number; headRefName: string }[] = JSON.parse(
		await gh(exec, [
			"pr",
			"list",
			"--repo",
			r,
			"--state",
			"open",
			"--limit",
			"1000",
			"--json",
			"number,headRefName",
		]),
	);
	// A run-filed ticket's branches are the run's too.
	const ours = [...keys, ...created];
	for (const pr of prs.filter((p) => ownBranch(p.headRefName, prefix, ours)))
		steps.push({
			what: `close PR #${pr.number} (${pr.headRefName})`,
			cmd: ["gh", "pr", "close", String(pr.number), "--repo", r],
		});
	const refs: string[] = (
		await gh(exec, [
			"api",
			"--paginate",
			`repos/${r}/git/matching-refs/heads/`,
			"--jq",
			".[].ref",
		])
	)
		.split("\n")
		.filter(Boolean)
		.map((ref) => ref.replace(/^refs\/heads\//, ""));
	for (const b of refs.filter((b) => ownBranch(b, prefix, ours)))
		if (b !== repo.main && !b.startsWith("reference/"))
			steps.push({
				what: `delete branch ${b} on ${r}`,
				cmd: ["gh", "api", "-X", "DELETE", `repos/${r}/git/refs/heads/${b}`],
			});

	// A worktree a run left would stop the next run's Portia from making its own there.
	if (o.profile.worktreesDir)
		for (const key of keys) {
			const wt = join(resolve(o.profile.worktreesDir), repo.name, key);
			if (!existsSync(join(wt, ".git"))) continue;
			// Removed through the repository that owns it, so its registration goes too.
			const common = await run(exec, [
				"git",
				"-C",
				wt,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			]);
			const owner = dirname(common.trim());
			steps.push({
				what: `remove the worktree ${wt} (of ${owner})`,
				cmd: ["git", "-C", owner, "worktree", "remove", "--force", wt],
			});
		}
	return steps;
}

/** Runs each step of a plan, in order. */
export async function applyReset(
	steps: ResetStep[],
	exec: Exec = spawnExec,
): Promise<void> {
	for (const s of steps) if (s.cmd.length) await run(exec, s.cmd);
}
