import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const EVAL = join(ROOT, "eval");

/** The environment of a fresh shell: no variables from the vitest run this test is in. */
const cleanEnv = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV",
		),
	);

function testFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((f) => !f.split("/").includes("node_modules"))
		.filter((f) => /\.test\.ts$/.test(f))
		.map((f) => relative(ROOT, join(dir, f)));
}

it("E1: Given the eval harness in eval/, Then its own tests pass under bun test and the main vitest run collects none of them", () => {
	expect(existsSync(join(EVAL, "package.json")), "eval/package.json").toBe(
		true,
	);
	const own = testFiles(EVAL);
	expect(own.length, "eval/ has tests of its own").toBeGreaterThan(0);

	const bun = spawnSync("bun", ["test"], {
		cwd: EVAL,
		env: cleanEnv(),
		encoding: "utf8",
		timeout: 300_000,
	});
	expect(bun.status, `${bun.stdout}\n${bun.stderr}`).toBe(0);

	const listed = spawnSync("bunx", ["vitest", "list", "--filesOnly"], {
		cwd: ROOT,
		env: cleanEnv(),
		encoding: "utf8",
	});
	expect(listed.status, listed.stderr).toBe(0);
	const collected = listed.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	expect(collected.length).toBeGreaterThan(0);
	expect(collected.filter((f) => f.startsWith("eval/"))).toEqual([]);
}, 320_000);
