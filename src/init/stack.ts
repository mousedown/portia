import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A command the repository gives evidence for, offered as a check. */
export interface CheckCandidate {
	cmd: string;
	/** The file that justifies it, shown beside it. */
	why: string;
	/** Ticked by default. Off when it would need more than the repository says. */
	preselect: boolean;
}

const CHECK_SCRIPTS = [
	"lint",
	"typecheck",
	"type-check",
	"check-types",
	"test",
];
const MAKE_TARGETS = ["test", "lint", "check", "build"];
const MAKE_CHECKS = new Set(["test", "lint", "check"]);

function runner(root: string): string {
	if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
		return "bun run";
	if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(root, "yarn.lock"))) return "yarn";
	return "npm run";
}

const read = (root: string, file: string) => {
	try {
		return readFileSync(join(root, file), "utf8");
	} catch {
		return undefined;
	}
};

/** Every package.json script as the command that runs it. */
export function packageScripts(root: string): string[] {
	const run = runner(root);
	return scriptNames(root).map((n) => `${run} ${n}`);
}

function scriptNames(root: string): string[] {
	const body = read(root, "package.json");
	if (body === undefined) return [];
	try {
		const { scripts } = JSON.parse(body) as {
			scripts?: Record<string, string>;
		};
		return Object.keys(scripts ?? {});
	} catch {
		return [];
	}
}

function fromPackageJson(root: string): CheckCandidate[] {
	const names = scriptNames(root);
	const run = runner(root);
	const why = "package.json";
	const checks = CHECK_SCRIPTS.filter((n) => names.includes(n));
	return [
		...checks.map((n) => ({ cmd: `${run} ${n}`, why, preselect: true })),
		...names
			.filter((n) => !checks.includes(n))
			.map((n) => ({ cmd: `${run} ${n}`, why, preselect: false })),
	];
}

function makeTargets(root: string): string[] {
	const body = read(root, "Makefile");
	if (body === undefined) return [];
	return MAKE_TARGETS.filter((t) =>
		new RegExp(`^${t}[ \\t]*:(?!=)`, "m").test(body),
	);
}

function fromPython(root: string, makeTest: boolean): CheckCandidate[] {
	const body = read(root, "pyproject.toml");
	if (body === undefined) return [];
	const prefix = existsSync(join(root, "uv.lock"))
		? "uv run "
		: existsSync(join(root, "poetry.lock"))
			? "poetry run "
			: "";
	const why = "pyproject.toml";
	return [
		...(/\bpytest\b/.test(body)
			? [{ cmd: `${prefix}pytest`, why, preselect: !makeTest }]
			: []),
		...(/\bruff\b/.test(body)
			? [{ cmd: `${prefix}ruff check .`, why, preselect: true }]
			: []),
	];
}

function fromXcode(root: string): CheckCandidate[] {
	const project = readdirSync(root).find((f) =>
		/\.(xcodeproj|xcworkspace)$/.test(f),
	);
	if (!project) return [];
	const scheme = project.replace(/\.[^.]+$/, "");
	// A scheme and a destination are not in any file worth parsing here: offered, never assumed.
	return [
		{
			cmd: `xcodebuild test -scheme ${scheme}`,
			why: project,
			preselect: false,
		},
	];
}

/**
 * The commands this repository gives evidence for. It never invents one: a repository with
 * no evidence gets nothing, so the person is asked rather than handed a command that does
 * not apply.
 */
export function detectChecks(root: string): CheckCandidate[] {
	const targets = makeTargets(root);
	const makeTest = targets.includes("test");
	const has = (file: string) => existsSync(join(root, file));
	const all: CheckCandidate[] = [
		...fromPackageJson(root),
		...targets.map((t) => ({
			cmd: `make ${t}`,
			why: "Makefile",
			preselect: MAKE_CHECKS.has(t),
		})),
		...fromPython(root, makeTest),
		...(has("go.mod")
			? [
					{ cmd: "go test ./...", why: "go.mod", preselect: !makeTest },
					{ cmd: "go vet ./...", why: "go.mod", preselect: true },
				]
			: []),
		...(has("Cargo.toml")
			? [
					{ cmd: "cargo test", why: "Cargo.toml", preselect: !makeTest },
					{ cmd: "cargo clippy", why: "Cargo.toml", preselect: true },
				]
			: []),
		...(has("Package.swift")
			? [{ cmd: "swift test", why: "Package.swift", preselect: !makeTest }]
			: []),
		...fromXcode(root),
	];
	return all;
}
