import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Exec, must } from "../../src/core/exec";

/** What each fixture child writes: the spine adds the acceptance test it makes pass. */
export const CHILD_FILES: Record<string, Record<string, string>> = {
	"GH-2": {
		"src/spine.ts": 'export const spine = (): string => "spine";\n',
		"test/spine.test.ts": [
			'import { expect, test } from "bun:test";',
			'import { spine } from "../src/spine";',
			"",
			'test("F1: the spine answers", () => {',
			'\texpect(spine()).toBe("spine");',
			"});",
			"",
		].join("\n"),
	},
	"GH-3": {
		"src/a.ts": `import { spine } from "./spine";\n\nexport const a = (): string => spine() + "-a";\n`,
	},
	"GH-4": {
		"src/b.ts": `import { spine } from "./spine";\n\nexport const b = (): string => spine() + "-b";\n`,
	},
};

/**
 * Stands in for a Claude worker: in the child's worktree it writes the child's files,
 * runs the evidence command, commits, and writes the result JSON `portia result` reads.
 * No model is called. Returns the result file's path.
 */
export async function scriptedWorker(
	exec: Exec,
	child: string,
	worktree: string,
	resultFile: string,
): Promise<string> {
	const files = CHILD_FILES[child];
	if (!files) throw new Error(`no scripted work for ${child}`);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(worktree, path)), { recursive: true });
		writeFileSync(join(worktree, path), text);
	}
	const test = await exec("bun", ["test"], { cwd: worktree });
	const gate = test.code === 0 ? "pass" : "fail";
	await must(exec, "git", ["add", "--", ...Object.keys(files)], {
		cwd: worktree,
	});
	await must(exec, "git", ["commit", "-q", "-m", `${child}: scripted work`], {
		cwd: worktree,
	});
	const head = (
		await must(exec, "git", ["rev-parse", "HEAD"], { cwd: worktree })
	).trim();
	const summary =
		`${test.stdout}\n${test.stderr}`
			.split("\n")
			.find((l) => /^Ran \d+ tests?/.test(l.trim()))
			?.trim() ?? `bun test exited ${test.code}`;
	const result =
		gate === "pass"
			? {
					child,
					status: "done",
					head,
					gates: { task: "pass", exit: "pass" },
					evidence: { F1: `bun test: ${summary}` },
				}
			: {
					child,
					status: "failed",
					head,
					gates: { task: "fail", exit: "fail" },
					evidence: {},
					reason: `bun test failed: ${summary}`,
				};
	writeFileSync(resultFile, JSON.stringify(result, null, 2));
	return resultFile;
}
