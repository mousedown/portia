import { type Exec, isDryRun, must } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import { mapLimit } from "../core/limit";
import { withPlanBlock } from "./block";
import type { IssueOpts, Tracker, TrackerIssue } from "./tracker";

interface GhIssue {
	number: number;
	pull_request?: unknown;
	id?: number;
	title: string;
	body: string | null;
	state: string;
	labels?: ({ name: string } | string)[];
}
interface GhBlocker {
	number: number;
	title?: string;
	repository_url: string;
}

/**
 * How a key names an issue: `number` reads `<prefix>-<n>` as issue #n; `title` reads the
 * key from the start of the issue's title, as `<KEY>: …` or `[<KEY>] …`.
 */
export type GitHubKeys = "number" | "title";

const TITLE_KEY = /^\s*(?:\[([A-Z][A-Z0-9]+-\d+)\]|([A-Z][A-Z0-9]+-\d+):)\s*/;

/** The key a title starts with, and the title without it; `EXT` names external tickets, so never a key. */
export function titleKey(title: string): { key: string; rest: string } | null {
	const m = title.match(TITLE_KEY);
	const key = m?.[1] ?? m?.[2];
	if (!m || !key || key.startsWith("EXT-")) return null;
	return { key, rest: title.slice(m[0].length) };
}

/** Labels from before `branchPrefix` existed; cleared along with the current ones. */
const LEGACY_LABEL_PREFIX = "portia:";
const labelName = (l: { name: string } | string) =>
	typeof l === "string" ? l : l.name;
/**
 * Children whose blockers are fetched at once. GitHub penalises bursts of concurrent
 * requests (secondary rate limits), so a large epic is never fetched all at once.
 */
export const GH_CONCURRENCY = 6;

/** Issues, sub-issues and issue dependencies through `gh api`. */
export class GitHubTracker implements Tracker {
	keyPattern = /^[A-Z][A-Z0-9]+-\d+$/;
	private readonly repo: string;
	private readonly prefix: string;
	private readonly exec: Exec;
	private readonly labelPrefix: string;
	private readonly keys: GitHubKeys;
	/** Title keys to issue numbers, read once per command; a key held by two issues maps to both. */
	private titleIndex?: Promise<Map<string, number[]>>;

	constructor(
		repo: string,
		keyPrefix: string,
		exec: Exec,
		labelPrefix = "portia",
		keys: GitHubKeys = "number",
	) {
		this.labelPrefix = `${labelPrefix}:`;
		this.repo = repo;
		this.prefix = keyPrefix;
		this.exec = exec;
		this.keys = keys;
	}

	private async number(key: string): Promise<number> {
		if (this.keys === "title") return this.titleNumber(key);
		const m = key.match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
		if (!m || m[1] !== this.prefix)
			throw new PortiaProblem(
				`'${key}' is not a ${this.prefix}-<number> key for ${this.repo}`,
			);
		return Number(m[2]);
	}

	async issueRef(key: string): Promise<string> {
		return `${this.repo}#${await this.number(key)}`;
	}

	/** One listing of every issue, open or closed, indexed by the key its title starts with. */
	private index(): Promise<Map<string, number[]>> {
		this.titleIndex ??= this.list<GhIssue>(
			`repos/${this.repo}/issues?state=all&per_page=100`,
		).then((all) => {
			const byKey = new Map<string, number[]>();
			for (const i of all) {
				const k = i.pull_request ? null : titleKey(i.title);
				if (k) byKey.set(k.key, [...(byKey.get(k.key) ?? []), i.number]);
			}
			return byKey;
		});
		return this.titleIndex;
	}

	private async titleNumber(key: string): Promise<number> {
		if (!this.keyPattern.test(key))
			throw new PortiaProblem(`'${key}' is not a ticket key`);
		const found = (await this.index()).get(key) ?? [];
		if (found.length > 1)
			throw new PortiaProblem(
				`${key} starts the title of more than one issue in ${this.repo}: ${found.map((n) => `#${n}`).join(", ")}`,
			);
		const n = found[0];
		if (n === undefined)
			throw new PortiaProblem(
				`no issue in ${this.repo} has a title starting '${key}:' or '[${key}]'`,
			);
		return n;
	}

	/** The key an issue is known by, and its title without a title key. */
	private named(n: number, title: string): { key: string; summary: string } {
		if (this.keys === "number")
			return { key: `${this.prefix}-${n}`, summary: title };
		const k = titleKey(title);
		if (!k)
			throw new PortiaProblem(
				`#${n} in ${this.repo} has no key at the start of its title ('<KEY>: …' or '[<KEY>] …')`,
			);
		return { key: k.key, summary: k.rest };
	}

	private path(n: number, tail = ""): string {
		return `repos/${this.repo}/issues/${n}${tail}`;
	}

	/** Every page of a list endpoint, flattened. `--slurp` wraps pages in an array. */
	private async list<T>(path: string): Promise<T[]> {
		const out = await must(this.exec, "gh", [
			"api",
			path,
			"--paginate",
			"--slurp",
		]);
		return (JSON.parse(out) as T[][]).flat();
	}

	private async raw(n: number): Promise<GhIssue> {
		return JSON.parse(await must(this.exec, "gh", ["api", this.path(n)]));
	}

	private blockerKey(b: GhBlocker): string {
		const same = b.repository_url
			.toLowerCase()
			.endsWith(`/repos/${this.repo}`.toLowerCase());
		if (!same) return `EXT-${b.number}`;
		return this.named(b.number, b.title ?? "").key;
	}

	private async build(
		n: number,
		raw: GhIssue,
		opts: IssueOpts = {},
	): Promise<TrackerIssue> {
		const blockers =
			opts.blockers === false
				? []
				: await this.list<GhBlocker>(this.path(n, "/dependencies/blocked_by"));
		return {
			...this.named(n, raw.title),
			description: raw.body ?? "",
			blockedBy: blockers.map((b) => this.blockerKey(b)),
			status: raw.state,
			labels: (raw.labels ?? []).map(labelName),
			done: raw.state === "closed",
		};
	}

	async issue(key: string, opts?: IssueOpts): Promise<TrackerIssue> {
		const n = await this.number(key);
		return this.build(n, await this.raw(n), opts);
	}

	async children(parentKey: string): Promise<TrackerIssue[]> {
		const n = await this.number(parentKey);
		const subs = await this.list<GhIssue>(
			this.path(n, "/sub_issues?per_page=100"),
		);
		return mapLimit(subs, GH_CONCURRENCY, (s) => this.build(s.number, s));
	}

	async comment(key: string, text: string): Promise<void> {
		if (isDryRun()) return;
		await must(this.exec, "gh", [
			"api",
			this.path(await this.number(key), "/comments"),
			"-X",
			"POST",
			"-f",
			`body=${text}`,
		]);
	}

	async transition(key: string, state: string): Promise<void> {
		if (isDryRun()) return;
		const n = await this.number(key);
		const kept = ((await this.raw(n)).labels ?? [])
			.map(labelName)
			.filter(
				(l) =>
					!l.startsWith(this.labelPrefix) && !l.startsWith(LEGACY_LABEL_PREFIX),
			);
		await must(
			this.exec,
			"gh",
			["api", this.path(n, "/labels"), "-X", "PUT", "--input", "-"],
			{
				input: JSON.stringify({
					labels: [...kept, `${this.labelPrefix}${state}`],
				}),
			},
		);
	}

	/** Reads then writes the whole description, so a human edit landing in between is lost (no version check). */
	async setPlanBlock(key: string, block: string): Promise<void> {
		if (isDryRun()) return;
		const n = await this.number(key);
		const body = withPlanBlock((await this.raw(n)).body ?? "", block);
		await must(this.exec, "gh", [
			"api",
			this.path(n),
			"-X",
			"PATCH",
			"-f",
			`body=${body}`,
		]);
	}

	async link(blocker: string, blocked: string): Promise<void> {
		if (isDryRun()) return;
		const blockerN = await this.number(blocker);
		const n = await this.number(blocked);
		const have = await this.list<GhBlocker>(
			this.path(n, "/dependencies/blocked_by"),
		);
		if (have.some((b) => this.blockerKey(b) === blocker)) return;
		const id = (await this.raw(blockerN)).id;
		if (id === undefined)
			throw new PortiaProblem(`${blocker}: GitHub returned no issue id`);
		await must(this.exec, "gh", [
			"api",
			this.path(n, "/dependencies/blocked_by"),
			"-X",
			"POST",
			"-F",
			`issue_id=${id}`,
		]);
	}
}
