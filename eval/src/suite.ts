import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * A suite: the repos, their epics, the scenarios and tickets the arms see, and where the
 * hidden specs are. A result names the suite version it ran on; a suite is never edited in place.
 */
const Scenario = z.object({ id: z.string(), text: z.string() });
const Epic = z.object({
	key: z.string(),
	title: z.string(),
	/** The parent as the tracker holds it, so an arm can be pointed at it. */
	tracker: z.enum(["github", "jira"]),
	scenarios: z.array(Scenario).min(1),
	/** Directory of hidden specs, relative to the suite file: one `<ID>.spec.ts` per scenario. */
	hidden: z.string(),
	/** Children as they exist in the tracker, with the paths each may touch, for the safety score. */
	children: z
		.array(z.object({ key: z.string(), touches: z.array(z.string()) }))
		.default([]),
	/** Expected outcome: a bad fit should be declined, not delivered. */
	expect: z.enum(["delivered", "declined"]).default("delivered"),
});
const Repo = z.object({
	name: z.string(),
	/** A git URL or a local path to clone from. */
	source: z.string(),
	/**
	 * Where an arm that pushes branches and opens pull requests (Portia) pushes them: the
	 * tracker's own repo, e.g. `git@github.com:mousedown/acme-shop.git`. It must hold the same
	 * `main` as `source`. Unset, the clone's origin stays `source`.
	 */
	remote: z.string().optional(),
	/** The branch the arms start from and that counts as main for the safety score. */
	main: z.string().default("main"),
	/** Run in the clone to install and prepare; must leave the test command runnable. */
	setup: z.string().optional(),
	/** Runs one hidden spec file; `{file}` is replaced. Exit 0 is a pass. */
	test: z.string(),
	/** The repo's own checks (lint, typecheck, its tests), as the scripted reviewer runs them. */
	checks: z.array(z.string()).default([]),
	epics: z.array(Epic).min(1),
});
export const Suite = z.object({
	version: z.string(),
	description: z.string().optional(),
	/** The model every arm runs on, passed to every session as `--model`. */
	model: z.string(),
	/** Per-run limits, the same for every arm. */
	limits: z.object({
		usd: z.number().positive().optional(),
		minutes: z.number().positive().default(180),
		/** Times a baseline is sent back while the repo's checks fail, after its first attempt. */
		reviews: z.number().int().min(0).default(3),
	}),
	/**
	 * Directory of tickets, relative to the suite file: one `<KEY>.md` per epic and child, the
	 * first line the title and the rest the body, as they are filed in the tracker.
	 */
	tickets: z.string(),
	/** The one subscription's weekly token ceiling; EVAL_WEEKLY_TOKENS overrides it, and 3M is the default. */
	budget: z
		.object({ weeklyTokens: z.number().int().positive().optional() })
		.optional(),
	repos: z.array(Repo).min(1),
});
export type Suite = z.infer<typeof Suite>;
export type Repo = z.infer<typeof Repo>;
export type Epic = z.infer<typeof Epic>;

export interface LoadedSuite extends Suite {
	/** The directory the suite file is in; `hidden` and `tickets` paths resolve against it. */
	dir: string;
	file: string;
}

/** EVAL_SOURCE_ACME_SHOP points the repo `acme-shop` at another checkout or URL. */
export const sourceVar = (name: string) =>
	`EVAL_SOURCE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export function loadSuite(file: string): LoadedSuite {
	const path = resolve(file);
	const parsed = Suite.parse(JSON.parse(readFileSync(path, "utf8")));
	for (const repo of parsed.repos) {
		const override = process.env[sourceVar(repo.name)];
		if (override) repo.source = override;
	}
	return { ...parsed, dir: dirname(path), file: path };
}

export function hiddenDir(suite: LoadedSuite, epic: Epic): string {
	return join(suite.dir, epic.hidden);
}

/** An epic's ticket and each child's, word for word as filed in the tracker. */
export interface Tickets {
	epic: string;
	children: Record<string, string>;
}

export function loadTickets(suite: LoadedSuite, epic: Epic): Tickets {
	const read = (key: string) => {
		const file = join(suite.dir, suite.tickets, `${key}.md`);
		if (!existsSync(file))
			throw new Error(
				`no ticket for ${key} in suite ${suite.version}: ${file}`,
			);
		return readFileSync(file, "utf8");
	};
	return {
		epic: read(epic.key),
		children: Object.fromEntries(
			epic.children.map((c) => [c.key, read(c.key)]),
		),
	};
}

export function findEpic(
	suite: LoadedSuite,
	key: string,
): { repo: Repo; epic: Epic } {
	for (const repo of suite.repos)
		for (const epic of repo.epics) if (epic.key === key) return { repo, epic };
	throw new Error(
		`no epic ${key} in suite ${suite.version}; epics: ${suite.repos
			.flatMap((r) => r.epics.map((e) => e.key))
			.join(", ")}`,
	);
}
