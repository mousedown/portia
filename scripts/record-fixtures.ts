#!/usr/bin/env bun
// Records a parent and its children (GET calls only) into test/fixtures.
//   bun scripts/record-fixtures.ts ACME-1              Jira  -> test/fixtures/jira
//   bun scripts/record-fixtures.ts --github owner/repo N  GitHub -> test/fixtures/github
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { must, realExec } from "../src/core/exec";
import { Jira, jiraFromEnv } from "../src/plan/jira";

if (process.argv[2] === "--github") {
	const repo = process.argv[3];
	const parent = process.argv[4];
	if (!repo || !parent) {
		console.error(
			"usage: bun scripts/record-fixtures.ts --github owner/repo N",
		);
		process.exit(1);
	}
	const out = join(import.meta.dir, "..", "test", "fixtures", "github");
	mkdirSync(out, { recursive: true });
	const get = async (path: string) =>
		JSON.parse(
			await must(realExec, "gh", ["api", path, "--paginate", "--slurp"]),
		) as unknown[];
	// Keep only what the adapter reads: no owner, permissions or node ids.
	const slim = (i: Record<string, unknown>) => ({
		number: i.number,
		id: i.id,
		title: i.title,
		body: i.body,
		state: i.state,
		repository_url: i.repository_url,
		labels: ((i.labels ?? []) as { name: string }[]).map((l) => ({
			name: l.name,
		})),
	});
	const slimPages = (pages: unknown[]) =>
		(pages as Record<string, unknown>[][]).map((pg) => pg.map(slim));
	const save = (name: string, data: unknown) =>
		writeFileSync(join(out, name), `${JSON.stringify(data, null, 2)}\n`);
	const issue = async (n: number | string) => {
		const [one] = (await get(`repos/${repo}/issues/${n}`)).flat();
		save(`issue-${n}.json`, slim(one as Record<string, unknown>));
		save(
			`issue-${n}-blocked-by.json`,
			slimPages(await get(`repos/${repo}/issues/${n}/dependencies/blocked_by`)),
		);
	};
	const subs = await get(
		`repos/${repo}/issues/${parent}/sub_issues?per_page=100`,
	);
	save(`issue-${parent}-sub-issues.json`, slimPages(subs));
	await issue(parent);
	for (const c of subs.flat() as { number: number }[]) await issue(c.number);
	console.log(`recorded ${repo}#${parent} into ${out}`);
	process.exit(0);
}

const key = process.argv[2]?.toUpperCase();
if (!key) {
	console.error("usage: bun scripts/record-fixtures.ts ACME-1");
	process.exit(1);
}
const dir = join(import.meta.dir, "..", "test", "fixtures", "jira");
mkdirSync(dir, { recursive: true });
const jira = new Jira(jiraFromEnv());
writeFileSync(
	join(dir, `${key}.json`),
	`${JSON.stringify(await jira.issue(key), null, 2)}\n`,
);
writeFileSync(
	join(dir, `${key}-children.json`),
	`${JSON.stringify(await jira.children(key), null, 2)}\n`,
);
console.log(`recorded ${key} into ${dir}`);
