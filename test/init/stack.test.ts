import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectChecks } from "../../src/init/stack";

const repo = (files: Record<string, string>) => {
	const dir = mkdtempSync(join(tmpdir(), "portia-stack-"));
	for (const [name, body] of Object.entries(files)) {
		if (name.endsWith("/")) mkdirSync(join(dir, name), { recursive: true });
		else writeFileSync(join(dir, name), body);
	}
	return dir;
};
const preselected = (dir: string) =>
	detectChecks(dir)
		.filter((c) => c.preselect)
		.map((c) => c.cmd);

describe("detectChecks", () => {
	it("takes package.json scripts with the lockfile's runner, preselecting only the checks", () => {
		const dir = repo({
			"package.json": JSON.stringify({
				scripts: { lint: "x", test: "y", build: "z" },
			}),
			"pnpm-lock.yaml": "",
		});
		expect(preselected(dir)).toEqual(["pnpm lint", "pnpm test"]);
		expect(detectChecks(dir).map((c) => c.cmd)).toContain("pnpm build");
	});
	it("reads Makefile targets, ignoring variables and recipes", () => {
		const dir = repo({
			Makefile:
				"GO := go\ntest:\n\t$(GO) test\nlint: deps\n\tx\nbuild:\n\ty\ndeploy:\n\tz\n",
		});
		expect(preselected(dir)).toEqual(["make test", "make lint"]);
		expect(detectChecks(dir).map((c) => c.cmd)).toEqual([
			"make test",
			"make lint",
			"make build",
		]);
	});
	it("proposes pytest and ruff only when pyproject names them", () => {
		expect(
			preselected(
				repo({
					"pyproject.toml":
						'[project]\ndependencies = ["pytest"]\n[tool.ruff]\n',
				}),
			),
		).toEqual(["pytest", "ruff check ."]);
		expect(preselected(repo({ "pyproject.toml": "[project]\n" }))).toEqual([]);
	});
	it("runs Python tools through uv or poetry when their lockfile is present", () => {
		const py = { "pyproject.toml": '[project]\ndependencies = ["pytest"]\n' };
		expect(preselected(repo({ ...py, "uv.lock": "" }))).toEqual([
			"uv run pytest",
		]);
		expect(preselected(repo({ ...py, "poetry.lock": "" }))).toEqual([
			"poetry run pytest",
		]);
	});
	it("proposes go, cargo and swift from their manifests", () => {
		expect(preselected(repo({ "go.mod": "module x\n" }))).toEqual([
			"go test ./...",
			"go vet ./...",
		]);
		expect(preselected(repo({ "Cargo.toml": "[package]\n" }))).toEqual([
			"cargo test",
			"cargo clippy",
		]);
		expect(preselected(repo({ "Package.swift": "" }))).toEqual(["swift test"]);
	});
	it("prefers make test over the toolchain's own command", () => {
		const dir = repo({ "go.mod": "module x\n", Makefile: "test:\n\tx\n" });
		expect(preselected(dir)).toEqual(["make test", "go vet ./..."]);
		expect(detectChecks(dir).map((c) => c.cmd)).toContain("go test ./...");
	});
	it("names an Xcode project's scheme but never preselects it, since it needs a destination", () => {
		const dir = repo({ "Widget.xcodeproj/": "" });
		expect(preselected(dir)).toEqual([]);
		expect(detectChecks(dir)[0]?.cmd).toBe("xcodebuild test -scheme Widget");
	});
	it("says why each command was proposed", () => {
		expect(detectChecks(repo({ "go.mod": "" }))[0]?.why).toBe("go.mod");
	});
	it("finds nothing, and invents nothing, in an empty repository", () => {
		expect(detectChecks(repo({}))).toEqual([]);
	});
	it("survives a package.json it cannot parse", () => {
		expect(detectChecks(repo({ "package.json": "{nope" }))).toEqual([]);
	});
});
