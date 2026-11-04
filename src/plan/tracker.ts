import type { Profile } from "../core/config";
import { realExec } from "../core/exec";
import { adfToText } from "./adf";
import { GitHubTracker } from "./github";
import { blockedBy, Jira, type JiraIssue, jiraFromEnv } from "./jira";

export interface TrackerIssue {
	/** ^[A-Z][A-Z0-9]+-\d+$ */
	key: string;
	summary: string;
	/** Plain text; the portia block is parsed from this. */
	description: string;
	/** Keys of issues this one waits on. */
	blockedBy: string[];
	status?: string;
	labels: string[];
	/** Finished in the tracker (Jira status category done; GitHub closed): never part of a run. */
	done: boolean;
}

export interface IssueOpts {
	blockers?: boolean;
}

export interface Tracker {
	keyPattern: RegExp;
	/**
	 * With `blockers: false` the caller never reads `blockedBy`, so a tracker that fetches
	 * blockers separately may skip that and leave it empty.
	 */
	issue(key: string, opts?: IssueOpts): Promise<TrackerIssue>;
	children(parentKey: string): Promise<TrackerIssue[]>;
	/** No-op under dry run. */
	comment(key: string, text: string): Promise<void>;
	/** No-op under dry run. */
	transition(key: string, state: string): Promise<void>;
	/**
	 * Leaves exactly one plan block, holding `block`, at the end of the description;
	 * any existing plan or portia block is replaced, the rest is kept. No-op under dry run.
	 * Reads then writes the whole description, so a human edit landing in between is lost (no version check exists).
	 */
	setPlanBlock(key: string, block: string): Promise<void>;
	/** Records "blocked is blocked by blocker" once; idempotent. No-op under dry run. */
	link(blocker: string, blocked: string): Promise<void>;
	issueRef?(key: string): Promise<string>;
}

type Env = Record<string, string | undefined>;
const KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

function toIssue(raw: JiraIssue): TrackerIssue {
	return {
		key: raw.key,
		summary: raw.fields.summary,
		description: adfToText(raw.fields.description),
		blockedBy: blockedBy(raw),
		status: raw.fields.status?.name,
		labels: raw.fields.labels ?? [],
		done: raw.fields.status?.statusCategory?.key === "done",
	};
}

export class JiraTracker implements Tracker {
	keyPattern = KEY_PATTERN;
	private readonly jira: Jira;

	constructor(jira: Jira) {
		this.jira = jira;
	}

	async issue(key: string): Promise<TrackerIssue> {
		return toIssue(await this.jira.issue(key));
	}
	async children(parentKey: string): Promise<TrackerIssue[]> {
		return (await this.jira.children(parentKey)).map(toIssue);
	}
	comment(key: string, text: string): Promise<void> {
		return this.jira.comment(key, text);
	}
	transition(key: string, state: string): Promise<void> {
		return this.jira.transition(key, state);
	}
	setPlanBlock(key: string, block: string): Promise<void> {
		return this.jira.setPlanBlock(key, block);
	}
	link(blocker: string, blocked: string): Promise<void> {
		return this.jira.link(blocker, blocked);
	}
}

export function trackerFromProfile(
	p: Profile,
	env: Env = process.env,
): Tracker {
	if (p.tracker.kind === "jira")
		return new JiraTracker(new Jira(jiraFromEnv(env)));
	return new GitHubTracker(
		p.tracker.repo,
		p.tracker.keyPrefix ?? "GH",
		realExec,
		p.branchPrefix,
		p.tracker.keys,
	);
}
