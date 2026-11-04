// Stands in for a headless Claude worker in the drive scenarios, started by Portia as
// `bun drive-worker.ts <portia's args>` with the brief on stdin. In the child's worktree it
// writes the child's fixture files, commits and writes its result where the brief says.
// A child named in DRIVE_PARK parks with a question until its brief carries an answer, one
// in DRIVE_PARK_ALWAYS parks whatever it carries, and one DRIVE_TOKENS names reports
// spending that many tokens. DRIVE_SEEN names a file each worker appends its child and the
// files under src/ to, and DRIVE_SPEC_ROUTE a route the spine's spec requests. A child in
// DRIVE_SPEC_CLAIM parks claiming its spec cannot pass until its brief says the spec was
// amended; an amendment brief rewrites that spec's assertion, keeping it, and commits.
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { CHILD_FILES } from "../e2e/scripted-worker";

const brief = readFileSync(0, "utf8");
const amending =
	/claims its spec cannot pass/.test(brief) &&
	/^You amend one acceptance spec/.test(brief);
const child = (
	amending
		? /for the spine\. ([A-Z][A-Z0-9]*-\d+) \(/
		: /You are a worker for ([A-Z][A-Z0-9]*-\d+)/
).exec(brief)?.[1];
const resultFile = /write the same object to `([^`]+)`/.exec(brief)?.[1];
if (!child || !resultFile) {
	console.error("drive-worker: the brief names no child or result file");
	process.exit(2);
}
const git = (...args: string[]) =>
	execFileSync("git", args, { encoding: "utf8" }).trim();
const result = (o: Record<string, unknown>) => {
	const text = JSON.stringify({ child, head: git("rev-parse", "HEAD"), ...o });
	writeFileSync(resultFile, text);
	const tokens = (
		JSON.parse(process.env.DRIVE_TOKENS ?? "{}") as Record<string, number>
	)[child];
	const usage = tokens ? { output_tokens: tokens } : {};
	console.log(JSON.stringify({ type: "result", result: text, usage }));
};

const spec = "test/spine.test.ts";
if (amending) {
	// The same assertion, on a copy of the value: a reorder, as an amendment of a matcher gotcha is.
	const src = readFileSync(spec, "utf8");
	writeFileSync(
		spec,
		src.replace(
			'\texpect(spine()).toBe("spine");',
			'\tconst got = spine();\n\texpect(got).toBe("spine");',
		),
	);
	git("add", "--", spec);
	git("commit", "-q", "-m", `test: amend ${spec} for ${child}`);
	result({
		status: "done",
		gates: { task: "pass", exit: "pass" },
		evidence: { F1: "bun test: Ran 1 test" },
	});
	process.exit(0);
}

const listed = (name: string) =>
	(process.env[name] ?? "").split(",").filter(Boolean).includes(child);
if (process.env.DRIVE_SEEN)
	appendFileSync(
		process.env.DRIVE_SEEN,
		`${child}: ${readdirSync("src").sort().join(",")}\n`,
	);
if (
	listed("DRIVE_PARK_ALWAYS") ||
	(listed("DRIVE_PARK") && !brief.includes("## Answer from the person"))
) {
	result({
		status: "parked",
		gates: { task: "pass", exit: "pass" },
		evidence: {},
		question: "Which greeting should it use?",
	});
	process.exit(0);
}

if (
	listed("DRIVE_SPEC_CLAIM") &&
	!brief.includes("was amended on the integration branch")
) {
	result({
		status: "parked",
		gates: { task: "pass", exit: "fail" },
		evidence: {},
		spec: {
			path: spec,
			assertion: 'expect(spine()).toBe("spine")',
			evidence:
				"bun test test/spine.test.ts: it fails whatever spine() returns",
		},
	});
	process.exit(0);
}

const files = { ...CHILD_FILES[child] };
const route = process.env.DRIVE_SPEC_ROUTE;
if (route && files[spec])
	files[spec] += `\n// It prices the order too: fetch("${route}")\n`;
for (const [path, text] of Object.entries(files)) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
git("add", "--", ...Object.keys(files));
git("commit", "-q", "-m", `${child}: scripted work`);
result({
	status: "done",
	gates: { task: "pass", exit: "pass" },
	evidence: { F1: "bun test: Ran 1 test" },
});
