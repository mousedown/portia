#!/usr/bin/env bun
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { EXIT } from "../core/exit";
import { profilesHome } from "../core/profile-file";
import { portiaHome } from "../core/rundir";
import { banner } from "../render/banner";
import { detect } from "../render/style";
import { accountsCommand } from "./commands/accounts";
import { amendCommand } from "./commands/amend";
import { briefCommand } from "./commands/brief";
import { checkCommand } from "./commands/check";
import { decideCommand } from "./commands/decide";
import { designCommand } from "./commands/design";
import { dispatchCommand } from "./commands/dispatch";
import { driveCommand } from "./commands/drive";
import { envCommand } from "./commands/env";
import { epicCommand } from "./commands/epic";
import { evalAnswerCommand } from "./commands/eval-answer";
import { gateCommand } from "./commands/gate";
import { initCommand } from "./commands/init";
import { insightsCommand } from "./commands/insights";
import { integrationCommand, landCommand } from "./commands/land";
import { ledgerCommand } from "./commands/ledger";
import { permissionsCommand } from "./commands/permissions";
import { planCommand } from "./commands/plan";
import { answerCommand, questionsCommand } from "./commands/questions";
import { resultCommand } from "./commands/result";
import { resumeCommand } from "./commands/resume";
import { signoffCommand } from "./commands/signoff";
import { statusCommand } from "./commands/status";
import { touchesCommand } from "./commands/touches";
import { verifyCommand } from "./commands/verify";
import { viewCommand } from "./commands/view";
import { workerCommand } from "./commands/worker";

export interface Io {
	out(s: string): void;
	err(s: string): void;
}
export type Command = (args: string[], io: Io) => Promise<number>;

export const commands: Record<string, Command> = {
	accounts: accountsCommand,
	amend: amendCommand,
	answer: answerCommand,
	brief: briefCommand,
	check: checkCommand,
	decide: decideCommand,
	design: designCommand,
	dispatch: dispatchCommand,
	drive: driveCommand,
	env: envCommand,
	epic: epicCommand,
	"eval-answer": evalAnswerCommand,
	gate: gateCommand,
	init: initCommand,
	insights: insightsCommand,
	integration: integrationCommand,
	land: landCommand,
	ledger: ledgerCommand,
	permissions: permissionsCommand,
	plan: planCommand,
	questions: questionsCommand,
	result: resultCommand,
	resume: resumeCommand,
	signoff: signoffCommand,
	status: statusCommand,
	touches: touchesCommand,
	verify: verifyCommand,
	view: viewCommand,
	worker: workerCommand,
	version: async (_args, io) => {
		io.out(`portia ${pkg.version}`);
		return EXIT.OK;
	},
};

/**
 * A dry run reads each run as it stands, so a plan check sees which children have started,
 * and writes nothing back: only the run logs are copied to the temp home.
 */
function copyRunLogs(from: string, to: string): void {
	const runs = join(from, "runs");
	if (!existsSync(runs)) return;
	for (const key of readdirSync(runs)) {
		const log = join(runs, key, "runlog.jsonl");
		if (!existsSync(log)) continue;
		mkdirSync(join(to, "runs", key), { recursive: true });
		copyFileSync(log, join(to, "runs", key, "runlog.jsonl"));
	}
}

export async function runCli(argv: string[], io: Io): Promise<number> {
	if (argv.includes("--dry-run")) {
		process.env.PORTIA_DRY_RUN = "1";
		const home = mkdtempSync(join(tmpdir(), "portia-dry-run-"));
		// Run state moves to the temp dir; the user's profiles stay where they are.
		process.env.PORTIA_PROFILES_DIR = profilesHome();
		copyRunLogs(portiaHome(), home);
		process.env.PORTIA_HOME = home;
		io.err(`[dry-run] run state goes to ${home}, not ~/.portia`);
		argv = argv.filter((a) => a !== "--dry-run");
	}
	const [name, ...rest] = argv;
	if (!name || name === "help" || name === "--help") {
		io.out(banner(detect()));
		io.out(
			"  Set up this repo:  portia init\n  Run an epic:       /portia <EPIC> in Claude Code\n\n  Commands: " +
				Object.keys(commands).join(", "),
		);
		return EXIT.OK;
	}
	const cmd = name ? commands[name] : undefined;
	if (!cmd) {
		io.err(
			`unknown command: ${name ?? "(none)"}. Commands: ${Object.keys(commands).join(", ")}`,
		);
		return EXIT.PROBLEM;
	}
	try {
		return await cmd(rest, io);
	} catch (e) {
		// Every failure maps to the 0/10/11 contract; an unexpected error is a problem too.
		io.err(e instanceof Error ? e.message : String(e));
		return EXIT.PROBLEM;
	}
}

if (import.meta.main) {
	// process.exit does not wait for a pipe to drain: a reader slower than us would lose
	// everything past the pipe's buffer (64 KiB), so every write is awaited first.
	let flushed: Promise<void> = Promise.resolve();
	const code = await runCli(process.argv.slice(2), {
		out: (s) => {
			const done = new Promise<void>((resolve) => {
				process.stdout.write(`${s}\n`, () => resolve());
			});
			flushed = flushed.then(() => done);
		},
		err: (s) => console.error(s),
	});
	await flushed;
	process.exit(code);
}
