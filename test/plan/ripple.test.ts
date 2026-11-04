import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEST_GLOBS } from "../../src/core/ripple";
import { rippleWarnings } from "../../src/plan/check";
import { childRipples, ImportGraph, specifiersOf } from "../../src/plan/ripple";

const globs = {
	tests: [...DEFAULT_TEST_GLOBS],
	generated: ["**/generated/**"],
};

function checkout(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "portia-ripple-scan-"));
	for (const [f, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), body);
	}
	return new ImportGraph(root, Object.keys(files));
}

describe("specifiersOf", () => {
	it("reads static, type, side-effect, re-export, dynamic, require and mock specifiers", () => {
		const src = [
			'import a from "./a";',
			"import {",
			"\tb,",
			"\tc,",
			'} from "./b";',
			'import type { T } from "@/types";',
			'import "./side";',
			'export * from "./re";',
			'export { x } from "./rx";',
			'const d = await import("./dyn");',
			'const e = require("./req");',
			'vi.mock("./mocked");',
			'jest.requireActual("./actual");',
			'export const s = "not-a-module";',
		].join("\n");
		expect(specifiersOf(src).sort()).toEqual(
			[
				"./a",
				"./b",
				"@/types",
				"./side",
				"./re",
				"./rx",
				"./dyn",
				"./req",
				"./mocked",
				"./actual",
			].sort(),
		);
	});
});

describe("ImportGraph", () => {
	it("resolves extensions, an index, and the TS file behind a .js specifier", () => {
		const g = checkout({
			"src/a.ts": "",
			"src/lib/index.tsx": "",
			"src/esm.ts": "",
			"src/main.ts":
				'import "./a"; import "./lib"; import "./esm.js"; import "react";',
		});
		expect([...(g.imports.get("src/main.ts") ?? [])].sort()).toEqual([
			"src/a.ts",
			"src/esm.ts",
			"src/lib/index.tsx",
		]);
	});
	it("resolves tsconfig paths aliases from the nearest tsconfig, through extends and comments", () => {
		const g = checkout({
			"tsconfig.base.json": [
				"{",
				"\t// shared",
				'\t"compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], /* exact */ "~db": ["./db/index.ts"], }, },',
				"}",
			].join("\n"),
			"tsconfig.json": '{ "extends": "./tsconfig.base.json" }',
			"packages/web/tsconfig.json": '{ "extends": "../../tsconfig.base" }',
			"packages/web/src/server/repo.ts": "",
			"packages/web/src/page.ts": 'import { r } from "@/server/repo";',
			"packages/api/tsconfig.json":
				'{ "compilerOptions": { "paths": { "@/*": ["./lib/*"], "@/server/*": ["./srv/*"] } } }',
			"packages/api/srv/x.ts": "",
			"packages/api/lib/server/x.ts": "",
			"packages/api/main.ts": 'import "@/server/x";',
			"src/root.ts": "",
			"db/index.ts": "",
			"top.ts": 'import "@/root"; import "~db";',
		});
		expect([...(g.imports.get("top.ts") ?? [])].sort()).toEqual([
			"db/index.ts",
			"src/root.ts",
		]);
		expect(g.imports.get("packages/web/src/page.ts")).toBeUndefined();
		expect([...(g.imports.get("packages/api/main.ts") ?? [])]).toEqual([
			"packages/api/srv/x.ts",
		]);
	});
	it("takes paths relative to the extending config's baseUrl", () => {
		const g = checkout({
			"base.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
			"pkg/tsconfig.json":
				'{ "extends": "../base.json", "compilerOptions": { "baseUrl": "." } }',
			"pkg/src/m.ts": "",
			"pkg/a.ts": 'import "@/m";',
		});
		expect([...(g.imports.get("pkg/a.ts") ?? [])]).toEqual(["pkg/src/m.ts"]);
	});
});

describe("childRipples", () => {
	const g = checkout({
		"tsconfig.json":
			'{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
		"src/invoices/total.ts": "export const total = 1;",
		"src/invoices/vat.ts": 'import { total } from "./total";',
		"src/ledger/csv.ts": 'import { total } from "@/invoices/total";',
		"src/generated/types.ts": 'import type { total } from "../invoices/total";',
		"test/invoices/total.test.ts":
			'import { total } from "../../src/invoices/total";',
		"src/fixtures/invoice.ts": 'import { total } from "@/invoices/total";',
		"test/other.test.ts": 'import { csv } from "../src/ledger/csv";',
	});
	const ripples = childRipples(
		[
			{ key: "ACME-2", touches: ["src/invoices/**"] },
			{ key: "ACME-3", touches: ["docs/**"] },
		],
		g,
		globs,
	);
	it("lists each importer outside the touches, by kind, and nothing inside them", () => {
		expect(ripples["ACME-2"]).toEqual([
			{ file: "src/fixtures/invoice.ts", kind: "test" },
			{ file: "src/generated/types.ts", kind: "generated" },
			{ file: "src/ledger/csv.ts", kind: "production" },
			{ file: "test/invoices/total.test.ts", kind: "test" },
		]);
		expect(ripples["ACME-3"]).toEqual([]);
	});
	it("warns only on production ripples, naming the child and the file", () => {
		expect(rippleWarnings(ripples)).toEqual([
			{
				rule: "ripple",
				level: "warn",
				child: "ACME-2",
				message: expect.stringMatching(/^ACME-2 .*src\/ledger\/csv\.ts/),
			},
		]);
	});
});
