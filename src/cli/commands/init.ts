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
import { suggestText } from "../../init/prompt";
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
	const root = await repositoryRoot();
	const found = await withExistingProfile(await detect(root, realExec), root);
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
		if (found.trackerSignal.ambiguous && !over.tracker)
			throw new PortiaProblem(
				`cannot tell which tracker this repository uses (${found.trackerSignal.reason}): name one with --answers, as {"tracker":{"kind":"github","repo":"owner/name"}} or {"tracker":{"kind":"jira"}}`,
			);
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

async function repositoryRoot(): Promise<string> {
	const r = await realExec("git", ["rev-parse", "--show-toplevel"], {
		cwd: process.cwd(),
	});
	if (r.code !== 0)
		throw new PortiaProblem(
			"portia init sets up a git repository, and this is not inside one: cd into your repository, or run git init",
		);
	return r.stdout.trim();
}

/** A profile already here is the best evidence of all: a re-run keeps its tracker and its place. */
async function withExistingProfile(
	found: Detected,
	root: string,
): Promise<Detected> {
	for (const saveTo of ["repo", "home"] as const) {
		const file = target(root, saveTo, found.answers.repo);
		if (!existsSync(file)) continue;
		try {
			const { tracker, transitions } = await loadProfileFile(file);
			return {
				...found,
				trackerSignal: {
					choice: tracker.kind,
					ambiguous: false,
					reason: `the profile at ${file} uses it`,
				},
				answers: {
					...found.answers,
					saveTo,
					transitions,
					tracker:
						tracker.kind === "github"
							? { kind: "github", repo: tracker.repo }
							: { kind: "jira" },
				},
			};
		} catch {
			// A profile that no longer loads says nothing; the person is replacing it anyway.
		}
	}
	return found;
}

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
	const override = process.env.PORTIA_PROFILE;
	if (override && override !== file)
		io.err(
			`PORTIA_PROFILE is set to ${override}, which outranks the profile just written. Unset it for this repository to use ${file}.`,
		);
	io.out(`profile written to ${file}`);
	return EXIT.OK;
}

const trackerLabel = (a: Answers) =>
	a.tracker.kind === "github"
		? `GitHub Issues (${a.tracker.repo})`
		: `Jira (statuses "${a.transitions.running}" → "${a.transitions.landed}")`;

const landingLabel = (a: Answers) =>
	a.directLand
		? `on local gates, no CI found (epics of up to ${a.directLand.maxChildren} tickets)`
		: "each ticket's PR waits for CI";

const SETTINGS = {
	tracker: "Tracker",
	checks: "Checks",
	landing: "Landing",
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
		landing: landingLabel(a),
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

/** A text prompt whose default shows as a suggestion: Enter takes it, Tab fills it to edit. */
async function text(
	message: string,
	value: string,
	validate?: (v: string) => string | undefined,
): Promise<string> {
	return ask(await suggestText({ message, suggestion: value, validate }));
}

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

async function askTrackerKind(a: Answers, found: Detected) {
	const hint = (kind: "github" | "jira") =>
		found.trackerSignal.choice === kind
			? found.trackerSignal.reason
			: undefined;
	return ask(
		await p.select({
			message: "Where do your tickets live?",
			initialValue: a.tracker.kind,
			options: [
				{
					value: "github" as const,
					label: "GitHub Issues",
					hint: hint("github"),
				},
				{ value: "jira" as const, label: "Jira", hint: hint("jira") },
			],
		}),
	);
}

const askGithubRepo = (suggestion: string) =>
	text("Which GitHub repository? (owner/name)", suggestion, (v) =>
		GITHUB_REPO.test(v) ? undefined : "Use owner/name",
	);

/** The first question, always. It asks for only what the choice cannot do without. */
async function chooseTracker(a: Answers, found: Detected) {
	const kind = await askTrackerKind(a, found);
	if (
		a.tracker.kind === "jira"
			? kind === "jira"
			: kind === "github" && a.tracker.repo
	)
		return;
	if (kind === "github") {
		a.tracker = {
			kind,
			repo: found.githubRepo ?? (await askGithubRepo("")),
		};
		a.transitions = GITHUB_TRANSITIONS;
		return;
	}
	a.tracker = { kind };
	a.transitions = JIRA_TRANSITIONS;
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
		await chooseTracker(a, found);
		// With nothing to run there is no sensible default.
		if (!a.checks.length) await QUESTIONS.checks(a, found);
		p.note(summary(a, root), "Settings");
		if (
			ask(
				await p.confirm({
					message: "Want to modify these settings?",
					initialValue: false,
				}),
			)
		) {
			const change = new Set(
				ask(
					await p.multiselect<Setting>({
						message: "Which settings?",
						options: (Object.keys(SETTINGS) as Setting[]).map((k) => ({
							value: k,
							label: SETTINGS[k],
						})),
						required: true,
					}),
				),
			);
			for (const k of Object.keys(SETTINGS) as Setting[])
				if (change.has(k)) await QUESTIONS[k](a, found);
		}

		if (a.tracker.kind === "jira" && !process.env.JIRA_API_TOKEN)
			p.log.warn(
				"Jira needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in your environment.",
			);
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
		await write(a, root, { out: () => {}, err: (s) => p.log.warn(s) });
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

const TYPE_A_COMMAND = "\0type";

const QUESTIONS: Record<
	Setting,
	(a: Answers, found: Detected) => Promise<void>
> = {
	async tracker(a, found) {
		const kind = await askTrackerKind(a, found);
		if (kind === "github") {
			const was = a.tracker.kind === "github" ? a.tracker.repo : "";
			a.tracker = {
				kind,
				repo: await askGithubRepo(was || (found.githubRepo ?? "")),
			};
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
		const typed = async (message: string) =>
			(
				await text(message, "", (v) =>
					v.trim() ? undefined : "Name at least one command",
				)
			)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		const known = found.candidates.map((c) => c.cmd);
		if (!known.length && !a.checks.length) {
			a.checks = await typed(
				"Which commands must pass before a ticket lands? (comma-separated)",
			);
			return;
		}
		const picked = ask(
			await p.multiselect<string>({
				message: "Which checks must pass before a ticket lands?",
				options: [
					...found.candidates.map((c) => ({
						value: c.cmd,
						label: c.cmd,
						hint: c.why,
					})),
					...a.checks
						.filter((c) => !known.includes(c))
						.map((c) => ({ value: c, label: c })),
					{ value: TYPE_A_COMMAND, label: "Type a command…" },
				],
				initialValues: a.checks,
				required: true,
			}),
		);
		const chosen = picked.filter((c) => c !== TYPE_A_COMMAND);
		a.checks =
			chosen.length === picked.length
				? chosen
				: [...chosen, ...(await typed("Which commands? (comma-separated)"))];
	},
	async landing(a) {
		const direct = ask(
			await p.select({
				message: "How should a finished ticket land?",
				initialValue: Boolean(a.directLand),
				options: [
					{
						value: false,
						label: "Wait for CI on each ticket's PR",
						hint: "needs CI on this repository",
					},
					{
						value: true,
						label: "On local gates alone",
						hint: "no CI needed; CI still runs on the epic PR. Epics of up to 4 tickets",
					},
				],
			}),
		);
		a.directLand = direct ? (a.directLand ?? { maxChildren: 4 }) : null;
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
