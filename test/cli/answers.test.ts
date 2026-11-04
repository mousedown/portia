import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "../../src/cli/main";
import { recordParkAnswer } from "../../src/core/park-answer";
import { runDir } from "../../src/core/rundir";
import { appendRow } from "../../src/core/runlog";

const saved = { home: process.env.PORTIA_HOME };
let dir = "";

beforeEach(() => {
	process.env.PORTIA_HOME = mkdtempSync(join(tmpdir(), "portia-answers-"));
	dir = runDir("A-1");
});

afterEach(() => {
	if (saved.home === undefined) delete process.env.PORTIA_HOME;
	else process.env.PORTIA_HOME = saved.home;
});

async function portia(...argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(argv, {
		out: (s) => out.push(s),
		err: (s) => err.push(s),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

it("exits 10 when nothing waits", async () => {
	const r = await portia("answers", "wait", "A-1", "--poll", "0.01");
	expect(r.code).toBe(10);
	expect(JSON.parse(r.out)).toEqual({ answered: [] });
});

it("ends as soon as an answer lands", async () => {
	appendRow(dir, {
		child: "A-2",
		attempt: 1,
		stage: "result",
		status: "parked",
		data: { message: "Which?" },
	});
	const waiting = portia("answers", "wait", "A-1", "--poll", "0.01");
	setTimeout(() => recordParkAnswer(dir, "A-2", "that one"), 30);
	const r = await waiting;
	expect(r.code).toBe(0);
	expect(JSON.parse(r.out)).toEqual({ answered: ["A-2"] });
});

it("ignores an answer older than --since, so a child short of a slot does not end every wait", async () => {
	appendRow(dir, {
		child: "A-2",
		attempt: 1,
		stage: "result",
		status: "parked",
		data: { message: "Which?" },
	});
	recordParkAnswer(dir, "A-2", "old");
	appendRow(dir, {
		child: "A-3",
		attempt: 1,
		stage: "result",
		status: "parked",
		data: { message: "And?" },
	});
	const since = new Date(Date.now() + 5).toISOString();
	await new Promise((r) => setTimeout(r, 10));
	const waiting = portia(
		"answers",
		"wait",
		"A-1",
		"--since",
		since,
		"--poll",
		"0.01",
	);
	setTimeout(() => recordParkAnswer(dir, "A-3", "new"), 30);
	expect(JSON.parse((await waiting).out)).toEqual({ answered: ["A-3"] });
});

it("refuses a poll interval that is not a positive number", async () => {
	const r = await portia("answers", "wait", "A-1", "--poll", "0");
	expect(r.code).toBe(11);
	expect(r.err).toContain("--poll <seconds> must be a positive number");
});

it("refuses an unknown subcommand", async () => {
	const r = await portia("answers", "list", "A-1");
	expect(r.code).toBe(11);
	expect(r.err).toContain("usage: portia answers wait");
});
