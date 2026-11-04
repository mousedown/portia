import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";

it("loading the CLI does not load playwright; only portia design needs it", () => {
	const main = join(import.meta.dirname, "../../src/cli/main.ts");
	const r = spawnSync(
		"bun",
		[
			"-e",
			`await import(${JSON.stringify(main)}); console.log(JSON.stringify(Object.keys(require.cache).filter((k) => /[\\\\/]playwright(-core)?[\\\\/]/.test(k))))`,
		],
		{ encoding: "utf8" },
	);
	expect(r.status, r.stderr).toBe(0);
	expect(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null")).toEqual([]);
});
