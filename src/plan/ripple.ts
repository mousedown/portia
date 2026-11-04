import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import type { Profile } from "../core/config";
import { type RippleGlobs, rippleClassifier } from "../core/ripple";
import type { ChildPlan, Ripple } from "../core/types";
import { parseChild, withPlanBlock } from "./block";
import type { CheckedPlan } from "./draft";
import { topLevelOf } from "./repo";

/** Files whose imports are read: JS and TS sources, in every module flavour. */
export const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
/** What an extensionless specifier may resolve to, in the order a bundler tries them. */
const EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".d.ts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];
/** A `.js` specifier in TS ESM names the `.ts` file beside it. */
const JS_TO_TS: Record<string, string[]> = {
	".js": [".ts", ".tsx"],
	".jsx": [".tsx"],
	".mjs": [".mts"],
	".cjs": [".cts"],
};

/** The files an import of `path` may load: itself, the TS file behind a `.js` path, an extension, an index. */
export function fileCandidates(path: string): string[] {
	const p = posix.normalize(path);
	if (p.startsWith("..")) return [];
	const ext = posix.extname(p);
	const stem = p.slice(0, p.length - ext.length);
	return [
		p,
		...(JS_TO_TS[ext] ?? []).map((e) => stem + e),
		...EXTENSIONS.map((e) => p + e),
		...EXTENSIONS.map((e) => `${p}/index${e}`),
	];
}

const SPECIFIERS = [
	// import x from "m", import { a } from "m", import "m", export * from "m", import type …
	/(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?["']([^"'\n]+)["']/g,
	// import("m"), require("m")
	/\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
	// vi.mock("m"), jest.mock("m"), vi.importActual("m"), jest.requireActual("m")
	/\b(?:vi|jest)\.(?:mock|doMock|unmock|importActual|requireActual)\s*\(\s*["']([^"'\n]+)["']/g,
];

/** Every module specifier `source` imports, requires or mocks. */
export function specifiersOf(source: string): string[] {
	const out = new Set<string>();
	for (const re of SPECIFIERS)
		for (const m of source.matchAll(re)) if (m[1]) out.add(m[1]);
	return [...out];
}

/** JSON with comments and trailing commas, as tsconfig allows; comments inside strings are kept. */
function parseJsonc(text: string): unknown {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++)
				if (text[i] === "\\") i++;
			out += text.slice(start, i + 1);
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 1;
		} else out += c;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface Aliases {
	/** Repo-relative directory the `paths` targets are relative to. */
	base: string;
	paths: Record<string, string[]>;
}

interface TsConfig {
	extends?: string | string[];
	compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/**
 * The `paths` aliases of the tsconfig at repo-relative `file`, following relative `extends`.
 * `paths` resolve against the `baseUrl` in effect, else the directory of the config that set them.
 */
function aliasesOf(
	root: string,
	file: string,
	seen = new Set<string>(),
): Aliases | null {
	if (seen.has(file)) return null;
	seen.add(file);
	let cfg: TsConfig;
	try {
		cfg = parseJsonc(readFileSync(join(root, file), "utf8")) as TsConfig;
	} catch {
		return null;
	}
	const dir = posix.dirname(file);
	const parents = [cfg.extends ?? []].flat().filter((e) => e.startsWith("."));
	let inherited: Aliases | null = null;
	for (const e of parents) {
		const target = posix.normalize(posix.join(dir, e));
		inherited =
			aliasesOf(
				root,
				target.endsWith(".json") ? target : `${target}.json`,
				seen,
			) ?? inherited;
	}
	const { baseUrl, paths } = cfg.compilerOptions ?? {};
	const base =
		baseUrl === undefined
			? undefined
			: posix.normalize(posix.join(dir, baseUrl));
	if (paths) return { base: base ?? dir, paths };
	if (inherited)
		return { base: base ?? inherited.base, paths: inherited.paths };
	return null;
}

/** Repo-relative targets an aliased `spec` maps to, longest matching prefix first, as tsc does. */
function aliasTargets(spec: string, a: Aliases): string[] {
	let best: { prefix: number; targets: string[] } | null = null;
	for (const [pattern, targets] of Object.entries(a.paths)) {
		const star = pattern.indexOf("*");
		const prefix = star < 0 ? pattern : pattern.slice(0, star);
		const suffix = star < 0 ? "" : pattern.slice(star + 1);
		const hit =
			star < 0
				? spec === pattern
				: spec.length >= prefix.length + suffix.length &&
					spec.startsWith(prefix) &&
					spec.endsWith(suffix);
		if (!hit || (best && best.prefix >= prefix.length)) continue;
		const matched =
			star < 0 ? "" : spec.slice(prefix.length, spec.length - suffix.length);
		best = {
			prefix: prefix.length,
			targets: targets.map((t) =>
				posix.normalize(posix.join(a.base, t.replace("*", matched))),
			),
		};
	}
	return best?.targets ?? [];
}

/** Which import of one checkout resolves to which file, read once for every child. */
export class ImportGraph {
	private readonly known: Set<string>;
	private readonly configs: Set<string>;
	private readonly aliases = new Map<string, Aliases | null>();
	/** Importer → the repo files it imports. */
	readonly imports = new Map<string, Set<string>>();

	constructor(
		private readonly root: string,
		files: string[],
	) {
		this.known = new Set(files);
		this.configs = new Set(
			files.filter((f) => posix.basename(f) === "tsconfig.json"),
		);
		for (const f of files) {
			if (!SOURCE.test(f)) continue;
			let source: string;
			try {
				source = readFileSync(join(root, f), "utf8");
			} catch {
				continue;
			}
			const targets = new Set(
				specifiersOf(source).flatMap((s) => this.resolve(f, s) ?? []),
			);
			targets.delete(f);
			if (targets.size) this.imports.set(f, targets);
		}
	}

	/** The repo file `spec` names from `importer`, or null for a package or an unknown path. */
	resolve(importer: string, spec: string): string | null {
		for (const t of this.targets(importer, spec)) {
			const hit = this.file(t);
			if (hit) return hit;
		}
		return null;
	}

	/**
	 * The repo paths `spec` may name from `importer`, before extensions, whether or not a
	 * file is there yet: a relative path, or the targets of a `paths` alias.
	 */
	targets(importer: string, spec: string): string[] {
		if (spec.startsWith("."))
			return [posix.join(posix.dirname(importer), spec)];
		const a = this.nearestAliases(posix.dirname(importer));
		return a ? aliasTargets(spec, a) : [];
	}

	/** `path` as a known file, trying extensions, the TS file behind a `.js` specifier, and an index. */
	private file(path: string): string | null {
		return fileCandidates(path).find((c) => this.known.has(c)) ?? null;
	}

	/** The aliases of the closest tsconfig.json at or above repo-relative `dir`. */
	private nearestAliases(dir: string): Aliases | null {
		const cached = this.aliases.get(dir);
		if (cached !== undefined) return cached;
		const config = posix.join(dir, "tsconfig.json");
		const found = this.configs.has(config)
			? aliasesOf(this.root, config)
			: dir === "." || dir === ""
				? null
				: this.nearestAliases(posix.dirname(dir));
		this.aliases.set(dir, found);
		return found;
	}
}

/**
 * Each child's ripples: the files outside its touches that import a file inside them, by
 * kind, sorted by path. A child with none maps to an empty list.
 */
export function childRipples(
	children: Pick<ChildPlan, "key" | "touches">[],
	graph: ImportGraph,
	globs: RippleGlobs,
): Record<string, Ripple[]> {
	const kind = rippleClassifier(globs);
	return Object.fromEntries(
		children.map((c) => {
			const mine = c.touches.length
				? picomatch(c.touches, { dot: true })
				: () => false;
			const files = [...graph.imports]
				.filter(([f, targets]) => !mine(f) && [...targets].some((t) => mine(t)))
				.map(([f]) => f)
				.sort();
			return [c.key, files.map((file) => ({ file, kind: kind(file) }))];
		}),
	);
}

/** The ripples of each child of a checked plan, scanning the checkout at `root`. */
export function planRipples(
	plan: Pick<CheckedPlan, "children">,
	files: string[],
	profile: Pick<Profile, "packageDir" | "askOnce" | "ripple">,
	root: string,
): Record<string, Ripple[]> {
	const topLevel = topLevelOf(files);
	const children = plan.children.map(({ key, block }) =>
		parseChild(
			{
				key,
				summary: "",
				description: withPlanBlock("", block),
				blockedBy: [],
			},
			topLevel,
			profile.packageDir,
			{ questions: profile.askOnce },
		),
	);
	return childRipples(children, new ImportGraph(root, files), profile.ripple);
}
