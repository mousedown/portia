import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { loadProfileFile } from "../../core/config";
import { isDryRun, realExec } from "../../core/exec";
import { EXIT, PortiaProblem } from "../../core/exit";
import { PROFILE_FILE, profilesHome } from "../../core/profile-file";
import {
	type Answers,
	type Detected,
	detect,
	GITHUB_TRANSITIONS,
	JIRA_TRANSITIONS,
	mergeAnswers,
	renderProfile,
} from "../../init/profile";
import { banner } from "../../render/banner";
import { detect as detectStyle } from "../../render/style";
import type { Command, Io } from "../main";

/**
 * `portia init` interviews the person and writes a profile. Every question shows the detected
 * answer as its default, so pressing Enter all the way through gives a working profile.
 *
 *   portia init                      interactive
 *   portia init --yes                accept every detected default
 *   portia init --yes --answers f    detected defaults overlaid with a JSON file of Answers
 *   portia init --detect             print the detected defaults as JSON and write nothing
 */
export const initCommand: Command = async (args, io) => {
	const root = process.cwd();
	const found = await detect(root, realExec);
	if (args.includes("--detect")) {
		io.out(
			JSON.stringify(
				{
					...found,
					files: {
						home: target(root, "home", found.answers.repo),
						repo: target(root, "repo", found.answers.repo),
					},
				},
				null,
				2,
			),
		);
		return EXIT.OK;
	}
	const force = args.includes("--force");
	if (args.includes("--yes")) {
		const file = flag(args, "--answers");
		const over = file
			? (JSON.parse(readFileSync(file, "utf8")) as Partial<Answers>)
			: {};
		const answers = mergeAnswers(found.answers, over);
		const out = target(root, answers.saveTo, answers.repo);
		if (existsSync(out) && !force)
			throw new PortiaProblem(
				`${out} already exists; pass --force to replace it`,
			);
		return write(answers, root, io);
	}
	if (!process.stdin.isTTY)
		throw new PortiaProblem(
			"portia init asks questions, so run it in a terminal, or pass --yes to accept the detected defaults",
		);
	return interview(found, root, force, io);
};

const flag = (args: string[], name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

const target = (root: string, saveTo: Answers["saveTo"], repo: string) =>
	saveTo === "repo"
		? join(root, PROFILE_FILE)
		: join(profilesHome(), `${repo}.ts`);

async function write(a: Answers, root: string, io: Io): Promise<number> {
	if (!a.checks.length)
		throw new PortiaProblem(
			"no checks: name at least one command that must pass (lint, test, …)",
		);
	const file = target(root, a.saveTo, a.repo);
	const source = renderProfile(a, root);
	if (isDryRun()) {
		io.out(source);
		return EXIT.OK;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source);
	await loadProfileFile(file); // fails with every bad field
	io.out(`profile written to ${file}`);
	return EXIT.OK;
}

const trackerLabel = (a: Answers) =>
	a.tracker.kind === "github"
		? `GitHub Issues (${a.tracker.repo})`
		: `Jira (statuses "${a.transitions.running}" → "${a.transitions.landed}")`;

const SETTINGS = {
	tracker: "Tracker",
	checks: "Checks",
	waveCap: "Workers",
	models: "Models",
	branchPrefix: "Branch prefix",
	saveTo: "Save to",
} as const;
type Setting = keyof typeof SETTINGS;

function summary(a: Answers, root: string): string {
	const rows: Record<Setting, string> = {
		tracker: trackerLabel(a),
		checks: a.checks.join(", ") || "(none found)",
		waveCap: `${a.waveCap} at once`,
		models: `${a.models.high} for hard tickets, ${a.models.standard} for routine ones`,
		branchPrefix: `${a.branchPrefix}/<KEY>`,
		saveTo: target(root, a.saveTo, a.repo),
	};
	return (Object.keys(SETTINGS) as Setting[])
		.map((k) => `${SETTINGS[k].padEnd(14)} ${rows[k]}`)
		.join("\n");
}

class Cancelled extends Error {}
function ask<T>(v: T): Exclude<T, symbol> {
	if (p.isCancel(v)) throw new Cancelled();
	return v as Exclude<T, symbol>;
}

/** A text prompt whose default shows as a placeholder and is taken on Enter. */
async function text(
	message: string,
	value: string,
	validate?: (v: string) => string | undefined,
): Promise<string> {
	return ask(
		await p.text({
			message,
			placeholder: value,
			defaultValue: value,
			validate: validate && ((v) => validate(v || value)),
		}),
	);
}

async function interview(
	found: Detected,
	root: string,
	force: boolean,
	io: Io,
): Promise<number> {
	const a: Answers = structuredClone(found.answers);
	io.err(banner(detectStyle()));
	p.intro(`Portia setup for ${a.repo}`);
	try {
		// With nothing to run there is no sensible default: ask before showing the summary.
		const change = new Set<Setting>(a.checks.length ? [] : ["checks"]);
		if (a.tracker.kind === "github" && !a.tracker.repo) change.add("tracker");
		p.note(summary(a, root), "Detected settings");
		if (
			!change.size &&
			ask(
				await p.confirm({
					message: "Want to modify these settings?",
					initialValue: false,
				}),
			)
		) {
			for (const k of ask(
				await p.multiselect<Setting>({
					message: "Which settings?",
					options: (Object.keys(SETTINGS) as Setting[]).map((k) => ({
						value: k,
						label: SETTINGS[k],
					})),
					required: true,
				}),
			))
				change.add(k);
		}
		for (const k of Object.keys(SETTINGS) as Setting[])
			if (change.has(k)) await QUESTIONS[k](a, found);

		const out = target(root, a.saveTo, a.repo);
		if (
			existsSync(out) &&
			!force &&
			!ask(
				await p.confirm({
					message: `${out} already exists. Replace it?`,
					initialValue: false,
				}),
			)
		)
			throw new Cancelled();
		await write(a, root, { out: () => {}, err: io.err });
		if (a.tracker.kind === "jira" && !process.env.JIRA_API_TOKEN)
			p.log.warn(
				"Jira needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in your environment.",
			);
		p.outro(
			`Saved ${out}\n   Next: open Claude Code in this repo and run /portia <EPIC>`,
		);
		return EXIT.OK;
	} catch (e) {
		if (!(e instanceof Cancelled)) throw e;
		p.cancel("Setup cancelled; nothing was written.");
		return EXIT.NOTHING;
	}
}

const QUESTIONS: Record<
	Setting,
	(a: Answers, found: Detected) => Promise<void>
> = {
	async tracker(a, found) {
		const detectedRepo =
			a.tracker.kind === "github" ? a.tracker.repo : (found.githubRepo ?? "");
		const kind = ask(
			await p.select({
				message: "Where do your tickets live?",
				initialValue: a.tracker.kind,
				options: [
					{ value: "github" as const, label: "GitHub Issues" },
					{ value: "jira" as const, label: "Jira" },
				],
			}),
		);
		if (kind === "github") {
			const repo = await text(
				"Which GitHub repository? (owner/name)",
				detectedRepo,
				(v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? undefined : "Use owner/name"),
			);
			a.tracker = { kind, repo };
			a.transitions = GITHUB_TRANSITIONS;
			return;
		}
		const was = a.tracker.kind === "jira" ? a.transitions : JIRA_TRANSITIONS;
		a.tracker = { kind };
		a.transitions = {
			running: await text(
				"Jira status while a ticket is being built?",
				was.running,
			),
			landed: await text("Jira status once it has landed?", was.landed),
		};
	},
	async checks(a, found) {
		if (found.scripts.length) {
			a.checks = ask(
				await p.multiselect({
					message: "Which checks must pass before a ticket lands?",
					options: found.scripts.map((s) => ({ value: s, label: s })),
					initialValues: a.checks,
					required: true,
				}),
			);
			return;
		}
		const cmds = await text(
			"Which commands must pass before a ticket lands? (comma-separated)",
			a.checks.join(", ") || "bun test",
		);
		a.checks = cmds
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	},
	async waveCap(a) {
		a.waveCap = Number(
			await text("How many workers can run at once?", String(a.waveCap), (v) =>
				/^[1-9]\d*$/.test(v) ? undefined : "A whole number, 1 or more",
			),
		);
	},
	async models(a) {
		a.models = {
			high: await text("Model for hard tickets?", a.models.high),
			standard: await text("Model for routine tickets?", a.models.standard),
		};
	},
	async branchPrefix(a) {
		a.branchPrefix = await text("Branch prefix?", a.branchPrefix, (v) =>
			/^[a-z][a-z0-9-]*$/.test(v) && v !== "main" && v !== "master"
				? undefined
				: "Lowercase letters, digits and dashes; not main or master",
		);
	},
	async saveTo(a, found) {
		a.saveTo = ask(
			await p.select({
				message: "Where should the profile live?",
				initialValue: a.saveTo,
				options: [
					{
						value: "home" as const,
						label: `~/.portia/profiles/${found.answers.repo}.ts`,
						hint: "just you",
					},
					{
						value: "repo" as const,
						label: PROFILE_FILE,
						hint: "committed, shared with your team",
					},
				],
			}),
		);
	},
};
