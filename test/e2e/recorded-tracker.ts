import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeTracker } from "../support/fake-tracker";

const RECORDED = join(import.meta.dirname, "..", "fixtures", "github");

/** FakeTracker holding the recorded fixture issues (parent GH-1 and its children), so no network is needed. */
export function recordedTracker(): FakeTracker {
	const read = (f: string) =>
		JSON.parse(readFileSync(join(RECORDED, f), "utf8"));
	const issue = (n: number) => {
		const raw = read(`issue-${n}.json`);
		const blockers = (
			read(`issue-${n}-blocked-by.json`) as { number: number }[][]
		)
			.flat()
			.map((b) => `GH-${b.number}`);
		return {
			key: `GH-${n}`,
			summary: raw.title,
			description: raw.body ?? "",
			blockedBy: blockers,
			status: raw.state,
		};
	};
	const t = new FakeTracker().add(issue(1));
	for (const s of (
		read("issue-1-sub-issues.json") as { number: number }[][]
	).flat())
		t.add(issue(s.number), "GH-1");
	return t;
}
