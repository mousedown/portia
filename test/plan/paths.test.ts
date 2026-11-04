import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inPackage, pkgRelative, repoPath } from "../../src/plan/paths";

it("inPackage and pkgRelative handle a nested packageDir", () => {
	expect(inPackage("packages/acme-web/src/a.ts", "packages/acme-web")).toBe(
		true,
	);
	expect(inPackage("root.ts", "packages/acme-web")).toBe(false);
	expect(inPackage("packages/acme-webx/a.ts", "packages/acme-web")).toBe(false);
	expect(pkgRelative("packages/acme-web/src/a.ts", "packages/acme-web")).toBe(
		"src/a.ts",
	);
});

it("inPackage and pkgRelative treat packageDir '.' as the whole repo", () => {
	expect(inPackage("src/a.ts", ".")).toBe(true);
	expect(pkgRelative("src/a.ts", ".")).toBe("src/a.ts");
});

it("repoPath takes a plan path as repo-relative or package-relative", () => {
	const root = mkdtempSync(join(tmpdir(), "paths-"));
	writeFileSync(join(root, "root.e2e.ts"), "");
	const pkg = "packages/acme-web";
	expect(repoPath(`${pkg}/e2e/a.e2e.ts`, pkg, root)).toBe(
		`${pkg}/e2e/a.e2e.ts`,
	);
	expect(repoPath("e2e/a.e2e.ts", pkg, root)).toBe(`${pkg}/e2e/a.e2e.ts`);
	expect(repoPath("root.e2e.ts", pkg, root)).toBe("root.e2e.ts");
	expect(repoPath("e2e/a.e2e.ts", ".", root)).toBe("e2e/a.e2e.ts");
});
