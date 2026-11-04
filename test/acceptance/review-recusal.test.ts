import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { realExec } from "../../src/core/exec";
import { writePlanSnapshot } from "../../src/core/plan-snapshot";
import { appendRow } from "../../src/core/runlog";
import { reviewChild } from "../../src/gate/review";
import { workerPaths } from "../../src/worker/detached";
import { sandbox } from "../helpers/git-sandbox";
import { child, parent, spine } from "../helpers/plan";

const SPEC = "packages/app/test/acceptance/greet.test.ts";
const SCENARIO = "F1: Given a name, Then it greets them";
const CODE = "packages/app/src/greet.ts";

/** What the worker said about its work: each must stay out of the review's input. */
const ACCOUNT = {
	message: "RESULT-MESSAGE-4d1e the greeting is done and tested",
	notes: "WORKER-NOTES-91c2 I chose a template string because it reads well",
	evidence: "WORKER-EVIDENCE-7f3a bunx vitest run: Tests 1 passed (1)",
};

/**
 * Stands in for the review command: records every PORTIA_* variable it was given, and the
 * text of each file it names, relative to its working directory. A variable may name a file
 * as its whole value, as a line, as any whitespace-separated token of a line, or as a string
 * anywhere inside JSON, so the format the review command is handed is not prescribed here.
 */
const RECORDER = `
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const seen = {};
const strings = (x) =>
	typeof x === "string" ? [x]
	: Array.isArray(x) ? x.flatMap(strings)
	: x && typeof x === "object" ? Object.values(x).flatMap(strings)
	: [];
const candidates = (v) => {
	const out = [v];
	try { out.push(...strings(JSON.parse(v))); } catch {}
	for (const s of [...out])
		for (const line of s.split("\\n").map((l) => l.trim()).filter(Boolean))
			out.push(line, ...line.split(/\\s+/));
	return [...new Set(out)];
};
for (const [k, v] of Object.entries(process.env)) {
	if (!k.startsWith("PORTIA_") || !v) continue;
	seen[k] = v;
	for (const c of candidates(v)) {
		const f = resolve(c);
		try { if (existsSync(f) && statSync(f).isFile()) seen[k + " " + c] = readFileSync(f, "utf8"); } catch {}
	}
}
writeFileSync(process.argv[2], JSON.stringify(seen));
console.log(JSON.stringify({ findings: [] }));
`;

/** The host's own PORTIA_* variables would reach the recorder and muddy what it saw. */
let hostEnv: Record<string, string | undefined> = {};
beforeEach(() => {
	hostEnv = Object.fromEntries(
		Object.keys(process.env)
			.filter((k) => k.startsWith("PORTIA_"))
			.map((k) => [k, process.env[k]]),
	);
	for (const k of Object.keys(hostEnv)) delete process.env[k];
});
afterEach(() => {
	for (const k of Object.keys(process.env))
		if (k.startsWith("PORTIA_")) delete process.env[k];
	for (const [k, v] of Object.entries(hostEnv))
		if (v !== undefined) process.env[k] = v;
});

it("R1: Given a child review, Then the review command receives the diff and the specs but none of the worker's result message, notes or evidence", async () => {
	const s = await sandbox();
	const tmp = mkdtempSync(join(tmpdir(), "portia-recusal-"));
	const dir = join(tmp, "run");
	mkdirSync(dir, { recursive: true });
	const write = (path: string, text: string) => {
		mkdirSync(dirname(join(s.repo, path)), { recursive: true });
		writeFileSync(join(s.repo, path), text);
	};

	// The spine's spec is on the integration branch the child started from.
	write(
		SPEC,
		[
			'import { afterEach, beforeEach, expect, it } from "vitest";',
			'import { greet } from "../../src/greet";',
			`it("${SCENARIO}", () => expect(greet("Ada")).toBe("Hello, Ada"));`,
			"",
		].join("\n"),
	);
	await s.g(s.repo, "add", ".");
	await s.g(s.repo, "commit", "-q", "-m", "ACME-1 specs");
	const base = (await s.g(s.repo, "rev-parse", "HEAD")).trim();
	await s.g(s.repo, "checkout", "-q", "-b", "portia/ACME-2");
	write(CODE, 'export const greet = (n: string) => "Hello, " + n;\n');
	await s.g(s.repo, "add", ".");
	await s.g(s.repo, "commit", "-q", "-m", "ACME-2 greet");
	const head = (await s.g(s.repo, "rev-parse", "HEAD")).trim();

	const plan = parent(
		[
			spine({ acceptance: { F1: SPEC } }),
			child("ACME-2", { touches: ["packages/app/src/**"] }),
		],
		[{ id: "F1", text: "Given a name, Then it greets them" }],
	);
	writePlanSnapshot(dir, plan);

	// The worker's own account of its work, everywhere it lands in the run dir.
	const paths = workerPaths(dir, "ACME-2", 1);
	const result = {
		child: "ACME-2",
		status: "done",
		head,
		gates: { task: "pass", exit: "pass" },
		evidence: { F1: ACCOUNT.evidence },
	};
	writeFileSync(paths.result, JSON.stringify(result));
	writeFileSync(
		paths.log,
		[
			JSON.stringify({
				type: "assistant",
				message: { content: [{ type: "text", text: ACCOUNT.notes }] },
			}),
			JSON.stringify({ type: "result", result: ACCOUNT.message }),
			"",
		].join("\n"),
	);
	appendRow(dir, { child: "ACME-2", attempt: 1, stage: "dispatched" });
	appendRow(dir, {
		child: "ACME-2",
		attempt: 1,
		stage: "result",
		status: "done",
		data: {
			head,
			message: ACCOUNT.message,
			notes: ACCOUNT.notes,
			evidence: result.evidence,
		},
	});

	const recorder = join(tmp, "recorder.ts");
	const seenFile = join(tmp, "seen.json");
	writeFileSync(recorder, RECORDER);
	const profile = testProfile();
	const v = await reviewChild({
		exec: realExec,
		profile,
		spec: {
			cmd: `bun ${recorder} ${seenFile}`,
			timeoutMs: 60_000,
			onFindings: "fail",
		},
		dir,
		env: {
			worktree: s.repo,
			branch: "portia/ACME-2",
			db: "",
			port: 3100,
			envFile: join(tmp, "missing.env"),
		},
		child: "ACME-2",
		parent: plan.key,
		base,
		head,
	});
	expect(v.status, v.tail).toBe("clean");

	const input = Object.values(
		JSON.parse(readFileSync(seenFile, "utf8")) as Record<string, string>,
	).join("\n");
	expect(input, "the diff").toContain("+export const greet");
	expect(input, "the acceptance spec").toContain(SCENARIO);
	for (const [what, text] of Object.entries(ACCOUNT))
		expect(input, `the worker's ${what}`).not.toContain(text.split(" ")[0]);
}, 60_000);
