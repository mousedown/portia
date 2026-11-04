import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import picomatch from "picomatch";
import type { ChildPlan, Finding, ParentPlan, ReqId } from "../core/types";
import { PLAN_BLOCK } from "./block";
import { fileCandidates, ImportGraph, SOURCE, specifiersOf } from "./ripple";

/**
 * A scenario's acceptance spec that reaches into another child's work: it imports a module
 * under that child's touches, or requests a route that child's ticket names. When the
 * scenario's owner does not need that child, its exit gate can fail on a feature that has
 * not landed, and it parks for something outside its touches.
 */
export interface Coupling {
	scenario: ReqId;
	spec: string;
	/** The child that owns the scenario. */
	owner: string;
	/** The child whose work the spec reaches, which the owner does not need. */
	other: string;
	via: "import" | "route";
	/** The import specifier or the route, as the spec writes it. */
	target: string;
}

/** String literals that read as a URL path: "/orders", `/orders/${id}/pay`. */
const CODE_ROUTE = /["'`](\/[A-Za-z_][^"'`\s]*)["'`]/g;
/** A path in prose, after a space, quote, backtick or bracket: `GET /orders/:id`. */
const TEXT_ROUTE = /(?:^|[\s`'"(<[])(\/[A-Za-z_][\w\-.:{}<>[\]/$*]*)/g;
const PARAM = /^[:{<[*]|\$\{/;
const TEST_FILE = /\.(?:test|spec|accept|it|e2e)\.[cm]?[jt]sx?$/;

/** A route as segments, each parameter (`:id`, `{id}`, `${x}`) a `*`; query and hash dropped. */
export function routeShape(route: string): string[] {
	return (route.split(/[?#]/)[0] ?? "")
		.replace(/[.,;:)\]]+$/, "")
		.split("/")
		.filter(Boolean)
		.map((s) => (PARAM.test(s) ? "*" : s.toLowerCase()));
}

const sameRoute = (a: string[], b: string[]) =>
	a.length === b.length &&
	a.every((s, i) => s === b[i] || s === "*" || b[i] === "*");

export const codeRoutes = (source: string) =>
	[...source.matchAll(CODE_ROUTE)].flatMap((m) => (m[1] ? [m[1]] : []));
export const textRoutes = (text: string) =>
	[...text.matchAll(TEXT_ROUTE)].flatMap((m) => (m[1] ? [m[1]] : []));

/** `key` and every child it needs, directly or through another need. */
function neededBy(plan: ParentPlan, key: string): Set<string> {
	const byKey = new Map(plan.children.map((c) => [c.key, c]));
	const out = new Set<string>();
	const walk = (k: string) => {
		for (const n of byKey.get(k)?.needs ?? [])
			if (!out.has(n.key)) {
				out.add(n.key);
				walk(n.key);
			}
	};
	walk(key);
	return out;
}

/**
 * Each acceptance spec of `plan` read from the checkout at `root` (the spine's worktree,
 * once it has written them), against every later child its scenario's owner does not need.
 * `tickets` holds each child's summary and description, where its routes are named. A
 * route counts only when the owner's own ticket does not name it and no source file already
 * holds it (test code and the spine's hook stubs aside), so a route the checkout already
 * serves never reads as someone else's feature.
 */
export function specCoupling(
	plan: ParentPlan,
	tickets: Map<string, string>,
	root: string,
	files: string[],
): Coupling[] {
	const closed = new Set(plan.closed ?? []);
	const open = plan.children.filter((c) => !closed.has(c.key));
	const specs = new Map(
		open.flatMap((c) => Object.entries(c.acceptance)) as [ReqId, string][],
	);
	const specFiles = new Set(specs.values());
	const read = (f: string) => {
		try {
			return readFileSync(join(root, f), "utf8");
		} catch {
			return null;
		}
	};
	// Only the tsconfigs are handed over: the aliases are wanted, not the whole import graph.
	const aliases = new ImportGraph(
		root,
		files.filter((f) => posix.basename(f) === "tsconfig.json"),
	);
	const known = new Set(files);
	const testCode = new Set<string>();
	const reach = [...specFiles];
	while (reach.length) {
		const f = reach.pop() as string;
		if (testCode.has(f)) continue;
		testCode.add(f);
		for (const s of specifiersOf(read(f) ?? ""))
			for (const p of aliases.targets(f, s).flatMap(fileCandidates))
				if (known.has(p) && !testCode.has(p)) reach.push(p);
	}
	const hookFiles = new Set(
		plan.children.flatMap((c) => Object.keys(c.hooks ?? {})),
	);
	let served: [string, string[][]][] | undefined;
	const servedOutside = (c: ChildPlan, shape: string[]) => {
		served ??= files
			.filter((f) => SOURCE.test(f) && !testCode.has(f) && !TEST_FILE.test(f))
			.map((f) => [f, codeRoutes(read(f) ?? "").map(routeShape)]);
		const mine = picomatch(c.touches, { dot: true });
		return served.some(
			([f, routes]) =>
				!(mine(f) && hookFiles.has(f)) &&
				routes.some((r) => sameRoute(r, shape)),
		);
	};
	const named = (key: string) =>
		textRoutes(tickets.get(key) ?? "").map(routeShape);

	const out: Coupling[] = [];
	for (const [scenario, spec] of specs) {
		const source = read(spec);
		if (source === null) continue;
		const owners = open.filter((c) => c.requirements.includes(scenario));
		// A later child that lists the scenario owns it; the spine only when none does.
		const later = owners.filter((c) => c.wave > 0);
		for (const owner of later.length ? later : owners) {
			const needed = neededBy(plan, owner.key);
			const ownerTouches = picomatch(owner.touches, { dot: true });
			const ownerRoutes = named(owner.key);
			const others = open.filter(
				(c) => c.wave > 0 && c.key !== owner.key && !needed.has(c.key),
			);
			for (const other of others) {
				const theirs = picomatch(other.touches, { dot: true });
				const add = (via: Coupling["via"], target: string) =>
					out.push({
						scenario,
						spec,
						owner: owner.key,
						other: other.key,
						via,
						target,
					});
				for (const s of specifiersOf(source)) {
					const paths = aliases.targets(spec, s).flatMap(fileCandidates);
					if (
						paths.some((p) => theirs(p)) &&
						!paths.some((p) => ownerTouches(p))
					)
						add("import", s);
				}
				const routes = named(other.key);
				for (const r of new Set(codeRoutes(source))) {
					const shape = routeShape(r);
					if (
						routes.some((t) => sameRoute(t, shape)) &&
						!ownerRoutes.some((t) => sameRoute(t, shape)) &&
						!servedOutside(other, shape)
					)
						add("route", r);
				}
			}
		}
	}
	return out;
}

/** One warning per coupling, naming both children so the plan or the spec can change. */
export function couplingWarnings(cs: Coupling[]): Finding[] {
	return cs.map((c) => ({
		rule: "coupling",
		level: "warn",
		child: c.owner,
		message: `${c.scenario}'s spec ${c.spec} ${c.via === "import" ? "imports" : "requests"} ${c.target}, which ${c.other} delivers, but ${c.owner} (owner of ${c.scenario}) does not need ${c.other}: decouple the spec, or add the need`,
	}));
}

/** A file path in prose, with an extension: `src/surcharge/rules.ts`. */
const TEXT_MODULE = /(?:^|[\s`'"(<[])((?:[\w.-]+\/)+[\w-]+\.[A-Za-z]{1,4})\b/g;
export const textModules = (text: string) =>
	[...text.matchAll(TEXT_MODULE)].flatMap((m) => (m[1] ? [m[1]] : []));

/**
 * Two later children whose tickets meet at one point: both name a route the spine's and the
 * parent's tickets do not (the shared contract's routes are the spine's), or one names a file
 * under the other's touches. One feature then plugs into the other's code, and without a
 * spine hook (a stub in the touches of either) the one plugging in must edit a sibling's
 * file, and parks. When one needs the other, it is the one that plugs in.
 */
export function hookWarnings(
	plan: ParentPlan,
	tickets: Map<string, string>,
	closed: Set<string> = new Set(plan.closed ?? []),
): Finding[] {
	const open = plan.children.filter((c) => !closed.has(c.key));
	const later = open.filter((c) => c.wave > 0);
	const spines = open.filter((c) => c.wave === 0);
	const text = (key: string) =>
		(tickets.get(key) ?? "").replace(PLAN_BLOCK, "");
	const routes = (key: string) => textRoutes(text(key)).map(routeShape);
	const contract = [plan.key, ...spines.map((c) => c.key)].flatMap(routes);
	const hookFiles = spines.flatMap((c) => Object.keys(c.hooks ?? {}));
	const spine = spines[0]?.key ?? "the spine";
	const out: Finding[] = [];
	for (let i = 0; i < later.length; i++)
		for (let j = i + 1; j < later.length; j++) {
			const pair = [later[i], later[j]] as [ChildPlan, ChildPlan];
			const covered = hookFiles.some((f) =>
				pair.some((c) => picomatch(c.touches, { dot: true })(f)),
			);
			if (covered) continue;
			const theirs = routes(pair[1].key);
			const route = routes(pair[0].key).find(
				(r) =>
					theirs.some((t) => sameRoute(t, r)) &&
					!contract.some((t) => sameRoute(t, r)),
			);
			const module = pair
				.flatMap((a, k) => {
					const b = pair[1 - k] as ChildPlan;
					const mine = picomatch(a.touches, { dot: true });
					const other = picomatch(b.touches, { dot: true });
					return textModules(text(a.key)).filter((f) => other(f) && !mine(f));
				})
				.at(0);
			const at = route ? `/${route.join("/")}` : module;
			if (!at) continue;
			const [a, b] = pair;
			const [plugs, into] = neededBy(plan, a.key).has(b.key)
				? [a, b]
				: neededBy(plan, b.key).has(a.key)
					? [b, a]
					: [undefined, undefined];
			const where = route ? `both name ${at}` : `meet at ${at}`;
			out.push({
				rule: "hook",
				level: "warn",
				child: (plugs ?? a).key,
				message: plugs
					? `${plugs.key} and ${into?.key} ${where}: ${plugs.key}'s feature plugs into code ${into?.key} owns. Give the plug-in point to the spine: a 'hook: <file> # <the stub>' line on ${spine}, with the file in ${plugs.key}'s touches, which ${into?.key} calls and ${plugs.key} fills, so neither edits the other's files`
					: `${a.key} and ${b.key} ${where}: one feature plugs into the other's code. Give the plug-in point to the spine: a 'hook: <file> # <the stub>' line on ${spine}, with the file in the touches of the child that fills it, so neither edits the other's files`,
			});
		}
	return out;
}
