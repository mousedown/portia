import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { rejectsIncremental, tscArgs } from "../../src/cli/commands/gate";
import { parseTsc } from "../../src/gate/typecheck";

const bin = join(
	dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
	"bin/tsc",
);
const tsc = (cwd: string, args: string[]) => {
	try {
		return execFileSync(process.execPath, [bin, ...args], { cwd }).toString();
	} catch (e) {
		return String((e as { stdout: Buffer }).stdout);
	}
};

it("keeps one build-info file per worktree in the run directory", () => {
	expect(tscArgs("/runs/ACME-500", "ACME-505")).toEqual([
		"tsc",
		"--noEmit",
		"--incremental",
		"--tsBuildInfoFile",
		"/runs/ACME-500/tsc-ACME-505.tsbuildinfo",
	]);
});

it("falls back to a full check when tsc rejects the incremental flags", () => {
	// TypeScript 3.4 to 3.9, and before 3.4.
	expect(
		rejectsIncremental(
			"error TS5053: Option 'incremental' cannot be specified with option 'noEmit'.\n",
		),
	).toBe(true);
	expect(
		rejectsIncremental(
			"error TS5023: Unknown compiler option 'tsBuildInfoFile'.\n",
		),
	).toBe(true);
	// An ordinary type error that mentions the word is not a rejection.
	expect(
		rejectsIncremental(
			"src/a.ts(1,7): error TS2322: Type 'incremental' is not assignable to type 'number'.\n",
		),
	).toBe(false);
	expect(rejectsIncremental("")).toBe(false);
});

it("an incremental run reports the same errors as a full one, cold, warm and after an edit", () => {
	const pkg = mkdtempSync(join(tmpdir(), "portia-tsc-"));
	const run = mkdtempSync(join(tmpdir(), "portia-run-"));
	onTestFinished(() => {
		rmSync(pkg, { recursive: true, force: true });
		rmSync(run, { recursive: true, force: true });
	});
	mkdirSync(join(pkg, "src"));
	writeFileSync(
		join(pkg, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
	);
	const a = (body: string) => writeFileSync(join(pkg, "src/a.ts"), body);
	a('export const a: number = "x";\nexport const b: string = 1;\n');
	writeFileSync(
		join(pkg, "src/b.ts"),
		'import { a } from "./a";\nexport const c: string = a;\n',
	);
	const incremental = tscArgs(run, "ACME-505").slice(1);
	const full = () => parseTsc(tsc(pkg, ["--noEmit"]));

	expect(parseTsc(tsc(pkg, incremental))).toEqual(full());
	// Warm: nothing changed, so every error comes from the build-info file.
	expect(parseTsc(tsc(pkg, incremental))).toEqual(
		new Map([
			["src/a.ts", 2],
			["src/b.ts", 1],
		]),
	);
	a("export const a = 1;\nexport const b: string = 1;\n");
	expect(parseTsc(tsc(pkg, incremental))).toEqual(full());
	expect(full()).toEqual(
		new Map([
			["src/a.ts", 1],
			["src/b.ts", 1],
		]),
	);
});
