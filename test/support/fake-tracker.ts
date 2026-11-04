import { isDryRun } from "../../src/core/exec";
import { PortiaProblem } from "../../src/core/exit";
import { withPlanBlock } from "../../src/plan/block";
import type { Tracker, TrackerIssue } from "../../src/plan/tracker";

export type FakeWrite =
	| { kind: "comment"; key: string; text: string }
	| { kind: "transition"; key: string; state: string }
	| { kind: "plan"; key: string; block: string }
	| { kind: "link"; blocker: string; blocked: string };

/** In-memory Tracker for tests; every write is logged in `writes`. */
export class FakeTracker implements Tracker {
	keyPattern = /^[A-Z][A-Z0-9]+-\d+$/;
	readonly writes: FakeWrite[] = [];
	private readonly issues = new Map<string, TrackerIssue>();
	private readonly kids = new Map<string, string[]>();

	/** `labels` defaults to none and `done` to false. */
	add(
		issue: Omit<TrackerIssue, "labels" | "done"> &
			Partial<Pick<TrackerIssue, "labels" | "done">>,
		parent?: string,
	): this {
		this.issues.set(issue.key, { labels: [], done: false, ...issue });
		if (parent)
			this.kids.set(parent, [...(this.kids.get(parent) ?? []), issue.key]);
		return this;
	}

	private get(key: string): TrackerIssue {
		const i = this.issues.get(key);
		if (!i) throw new PortiaProblem(`${key}: no such issue`);
		return i;
	}

	async issue(key: string): Promise<TrackerIssue> {
		return this.get(key);
	}
	async children(parentKey: string): Promise<TrackerIssue[]> {
		return (this.kids.get(parentKey) ?? []).map((k) => this.get(k));
	}
	async comment(key: string, text: string): Promise<void> {
		this.get(key);
		if (isDryRun()) return;
		this.writes.push({ kind: "comment", key, text });
	}
	async transition(key: string, state: string): Promise<void> {
		const i = this.get(key);
		if (isDryRun()) return;
		i.status = state;
		this.writes.push({ kind: "transition", key, state });
	}
	async setPlanBlock(key: string, block: string): Promise<void> {
		const i = this.get(key);
		if (isDryRun()) return;
		i.description = withPlanBlock(i.description, block);
		this.writes.push({ kind: "plan", key, block });
	}
	async link(blocker: string, blocked: string): Promise<void> {
		this.get(blocker);
		const i = this.get(blocked);
		if (isDryRun() || i.blockedBy.includes(blocker)) return;
		i.blockedBy = [...i.blockedBy, blocker];
		this.writes.push({ kind: "link", blocker, blocked });
	}
}
