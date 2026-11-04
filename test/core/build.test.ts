import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { buildLabel } from "../../src/core/build";

it("names the version and the commit in a git checkout", () => {
	const repo = join(import.meta.dirname, "../..");
	expect(buildLabel(repo)).toMatch(
		new RegExp(`^v${pkg.version.replaceAll(".", "\\.")} [0-9a-f]{7,}$`),
	);
});
it("names the version alone outside one", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-build-"));
	expect(buildLabel(dir)).toBe(`v${pkg.version}`);
});
