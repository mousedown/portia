import { posix } from "node:path";
import picomatch from "picomatch";
import type { Profile } from "../core/config";
import type {
	ChildPlan,
	Finding,
	Lane,
	ParentPlan,
	Ripple,
	Rule,
	RunRow,
} from "../core/types";
import { hookWarnings } from "./coupling";

/** Child sizes in order; a profile's `maxSize` allows every size up to and including it. */
export const SIZES = ["XS", "S", "M", "L"] as const;
export type Size = (typeof SIZES)[number];

const allowedUpTo = (max: Size): string[] =>
	SIZES.slice(0, SIZES.indexOf(max) + 1);
const listed = (xs: string[]) =>
	xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
const err = (rule: Rule, message: string, child?: string): Finding => ({
	rule,
	level: "error",
	child,
	message,
});
const warn = (rule: Rule, message: string, child?: string): Finding => ({
	rule,
	level: "warn",
	child,
	message,
});

const literal = (g: string) =>
	g
		.replace(/\{([^,}]*)[^}]*\}/g, "$1")
		.replace(/\*\*/g, "x/x")
		.replace(/\*/g, "x")
		.replace(/\?/g, "x")
		.replace(/\[[^\]]*\]/g, "x");

export function intersect(
	a: string[],
	b: string[],
	files: string[],
): string | null {
	const ma = picomatch(a, { dot: true });
	const mb = picomatch(b, { dot: true });
	for (const f of files) if (ma(f) && mb(f)) return f;
	for (const g of [...a, ...b]) {
		const l = literal(g);
		if (ma(l) && mb(l)) return l;
	}
	return null;
}

function completeness(p: ParentPlan): Finding[] {
	return p.children.flatMap((c) => [
		...(c.touches.length
			? []
			: [err("completeness", `${c.key} has no touches`, c.key)]),
		...(c.wave > 0 && !c.requirements.length
			? [err("completeness", `${c.key} has no requirements`, c.key)]
			: []),
		...(c.evidence
			? []
			: [err("completeness", `${c.key} has no evidence command`, c.key)]),
	]);
}

/**
 * A scenario is owned by a child that lists it in `requirements`. The spine may own one no
 * later child can deliver; one it shares with a later child is left to that child, since
 * the spine lands first and cannot make it pass alone.
 */
function coverage(p: ParentPlan, closed: Set<string>): Finding[] {
	const ids = new Set(p.scenarios.map((s) => s.id));
	const open = p.children.filter((c) => !closed.has(c.key));
	const owned = new Set(open.flatMap((c) => c.requirements));
	const later = open.filter((c) => c.wave > 0);
	return [
		...[...ids]
			.filter((id) => !owned.has(id))
			.map((id) => err("coverage", `${id} is owned by no child`)),
		...open
			.filter((c) => c.wave === 0)
			.flatMap((s) =>
				s.requirements.flatMap((r) => {
					const also = later.filter((c) => c.requirements.includes(r));
					return also.length
						? [
								warn(
									"coverage",
									`${r} is owned by the spine ${s.key} and by ${also.map((c) => c.key).join(", ")}: the spine's gate leaves it to them; the spine should own only a scenario no later child can deliver`,
									s.key,
								),
							]
						: [];
				}),
			),
		...open.flatMap((c) =>
			c.requirements
				.filter((r) => !ids.has(r))
				.map((r) =>
					err(
						"coverage",
						`${c.key} cites ${r}, which the parent does not define`,
						c.key,
					),
				),
		),
	];
}

function graph(p: ParentPlan): Finding[] {
	const byKey = new Map(p.children.map((c) => [c.key, c]));
	const satisfied = new Set(p.satisfied ?? []);
	return p.children.flatMap((c) => [
		...c.needs.flatMap((n) => {
			const dep = byKey.get(n.key);
			if (!dep && satisfied.has(n.key))
				return c.blockedBy.includes(n.key)
					? []
					: [
							err(
								"graph",
								`${c.key} needs ${n.key} but the tracker has no 'is blocked by ${n.key}' link`,
								c.key,
							),
						];
			if (!dep)
				return [
					err(
						"graph",
						`${c.key} needs ${n.key}, which is not a child of ${p.key}`,
						c.key,
					),
				];
			return [
				...(dep.wave >= c.wave
					? [
							err(
								"graph",
								`${c.key} (wave ${c.wave}) needs ${n.key} (wave ${dep.wave}); a need must be in an earlier wave`,
								c.key,
							),
						]
					: []),
				...(c.blockedBy.includes(n.key)
					? []
					: [
							err(
								"graph",
								`${c.key} needs ${n.key} but the tracker has no 'is blocked by ${n.key}' link`,
								c.key,
							),
						]),
				...(n.reason
					? []
					: [warn("graph", `${c.key} needs ${n.key} without a reason`, c.key)]),
			];
		}),
		...c.blockedBy
			.filter((b) => byKey.has(b) && !c.needs.some((n) => n.key === b))
			.map((b) =>
				warn(
					"graph",
					`The tracker says ${c.key} is blocked by ${b}, but its needs omit it`,
					c.key,
				),
			),
	]);
}

function overlap(p: ParentPlan, files: string[]): Finding[] {
	const out: Finding[] = [];
	const waves = new Map<number, ChildPlan[]>();
	for (const c of p.children)
		waves.set(c.wave, [...(waves.get(c.wave) ?? []), c]);
	for (const [wave, cs] of waves) {
		for (let i = 0; i < cs.length; i++) {
			for (let j = i + 1; j < cs.length; j++) {
				const a = cs[i] as ChildPlan,
					b = cs[j] as ChildPlan;
				const hit = intersect(a.touches, b.touches, files);
				if (hit)
					out.push(
						err(
							"overlap",
							`${a.key} and ${b.key} both touch ${hit} in wave ${wave} (G8)`,
							a.key,
						),
					);
				if (a.evidence && a.evidence === b.evidence)
					out.push(
						warn(
							"overlap",
							`${a.key} and ${b.key} share the evidence command '${a.evidence}'`,
							a.key,
						),
					);
			}
		}
	}
	return out;
}

function spine(p: ParentPlan, closed: Set<string>): Finding[] {
	const zero = p.children.filter((c) => c.wave === 0);
	if (!zero.length) return [err("spine", "no wave 0 (spine) child")];
	return p.scenarios
		.filter((s) => !zero.some((c) => !closed.has(c.key) && c.acceptance[s.id]))
		.map((s) =>
			err("spine", `the spine names no failing acceptance test for ${s.id}`),
		);
}

/** Where a spec belongs under `touches`: the directory of the first spec-like glob, else of the first. */
function specHome(touches: string[], file: string): string {
	const glob =
		touches.find((t) => /(^|\/)(specs?|tests?|e2e|__tests__)(\/|$)/.test(t)) ??
		touches[0] ??
		"";
	const segments = glob.split("/");
	const wild = segments.findIndex((x) => /[*?[{]/.test(x));
	const dir =
		wild < 0 ? posix.dirname(glob) : segments.slice(0, wild).join("/");
	return dir && dir !== "."
		? `${dir}/${posix.basename(file)}`
		: posix.basename(file);
}

/**
 * Each acceptance spec sits inside the touches of the child that owns its scenario (a later
 * child listing it, or the spine when none does), so the epic's diff stays within the paths
 * its tickets declare, and inside the spine's touches too, since the spine writes it. A child
 * the run has started is never re-planned, so its touches cannot change: a spec whose owners
 * have all started is not held to it, nor is a spine already started.
 */
function specs(
	p: ParentPlan,
	closed: Set<string>,
	started: Set<string>,
): Finding[] {
	const open = p.children.filter((c) => !closed.has(c.key));
	return open
		.filter((s) => s.wave === 0)
		.flatMap((s) =>
			Object.entries(s.acceptance).flatMap(([id, path]) => {
				const later = open.filter(
					(c) => c.wave > 0 && c.requirements.includes(id),
				);
				const owners = later.length
					? later
					: s.requirements.includes(id)
						? [s]
						: [];
				const inside = (c: ChildPlan) =>
					picomatch(c.touches, { dot: true })(path);
				const out: Finding[] = [];
				const [first] = owners;
				if (
					first &&
					!owners.some(inside) &&
					!owners.every((o) => started.has(o.key))
				)
					out.push(
						err(
							"specs",
							`${id}'s spec ${path} sits outside the touches of ${owners.map((o) => `${o.key} (${o.touches.join(", ")})`).join(" and ")}, which ${owners.length > 1 ? "own" : "owns"} ${id}: put it under the owner's paths, for example ${specHome(first.touches, path)}, and list that path in ${s.key}'s touches`,
							s.key,
						),
					);
				if (!started.has(s.key) && !inside(s))
					out.push(
						err(
							"specs",
							`the spine ${s.key} writes ${id}'s spec ${path}, which its touches do not hold: list ${path} in its touches`,
							s.key,
						),
					);
				return out;
			}),
		);
}

/**
 * A hook is a stub module the spine scaffolds where one child's feature plugs into code
 * another child owns: it sits in the spine's touches, and in the touches of the later child
 * that fills it, so the child that calls it never edits a sibling's file.
 */
function hooks(p: ParentPlan, closed: Set<string>): Finding[] {
	const later = p.children.filter((c) => c.wave > 0 && !closed.has(c.key));
	return p.children.flatMap((c) =>
		Object.keys(c.hooks ?? {}).flatMap((path) => {
			if (c.wave > 0)
				return [
					err(
						"hook",
						`${c.key} names the hook ${path}, but only the spine scaffolds hooks: move the line to the wave 0 block`,
						c.key,
					),
				];
			const holds = (x: ChildPlan) => picomatch(x.touches, { dot: true })(path);
			return [
				...(holds(c)
					? []
					: [
							err(
								"hook",
								`the spine ${c.key} scaffolds the hook ${path}, which its touches do not hold: list ${path} in its touches`,
								c.key,
							),
						]),
				...(later.some(holds)
					? []
					: [
							warn(
								"hook",
								`the hook ${path} is in no later child's touches, so no child fills it: it belongs in the touches of the child whose feature plugs in there`,
								c.key,
							),
						]),
			];
		}),
	);
}

function size(p: ParentPlan, maxSize: Size): Finding[] {
	const allowed = allowedUpTo(maxSize);
	if (p.children.length < 2)
		return [
			err(
				"size",
				"only one child: one worker can finish this, so it is declined (Y2)",
			),
		];
	return p.children.flatMap((c) => {
		if (!c.size) return [warn("size", `${c.key} has no size`, c.key)];
		return allowed.includes(c.size)
			? []
			: [
					err(
						"size",
						`${c.key} is size ${c.size}; children must be ${listed(allowed)} (P6)`,
						c.key,
					),
				];
	});
}

export type LaneProfile = Pick<Profile, "lanes" | "sensitiveGlobs">;

/** A block's `lane:` wins; with no `lanes` in the profile every other child is full. */
export function laneOf(
	p: ParentPlan,
	c: ChildPlan,
	files: string[],
	profile: LaneProfile,
): { lane: Lane; why: string } {
	if (c.lane) return { lane: c.lane, why: "set in its block" };
	const rules = profile.lanes;
	const full = (why: string) => ({ lane: "full" as const, why });
	if (!rules) return full("the profile sets no lanes");
	if (c.wave === 0) return full("it is the spine");
	if (!c.size || !allowedUpTo(rules.maxSize).includes(c.size))
		return full(`size ${c.size ?? "unset"} is over ${rules.maxSize}`);
	if (c.design) return full("it has a design check");
	// The spine lists each acceptance spec in its touches because it writes it; the owner
	// then makes it pass, which shares no code with the spine.
	const spine = p.children
		.filter((x) => x.wave === 0 && x.key !== c.key)
		.flatMap((x) => {
			const specs = new Set(Object.values(x.acceptance));
			return x.touches.filter((t) => !specs.has(t));
		});
	const shared = spine.length ? intersect(c.touches, spine, files) : null;
	if (shared) return full(`it touches ${shared}, which the spine owns`);
	const globs = [...profile.sensitiveGlobs, ...rules.fullTouches];
	const hit = globs.length ? intersect(c.touches, globs, files) : null;
	if (hit) return full(`it touches ${hit}, which is sensitive`);
	return {
		lane: "light",
		why: "small and clear of the spine and sensitive code",
	};
}

/** The lane recorded at the child's last dispatch, which every later call keeps to. */
export function dispatchedLane(rows: RunRow[], key: string): Lane | undefined {
	const lane = rows
		.filter((r) => r.child === key && r.stage === "dispatched")
		.at(-1)?.data?.lane;
	return lane === "light" || lane === "full" ? lane : undefined;
}

/**
 * Each child's lane, or undefined when neither the profile nor any block uses lanes. A
 * dispatched child keeps the lane recorded then, whatever files this checkout holds now.
 */
export function childLanes(
	p: ParentPlan,
	files: string[],
	profile: LaneProfile,
	rows: RunRow[] = [],
): Map<string, Lane> | undefined {
	if (!profile.lanes && !p.children.some((c) => c.lane)) return undefined;
	return new Map(
		p.children.map((c) => [
			c.key,
			dispatchedLane(rows, c.key) ?? laneOf(p, c, files, profile).lane,
		]),
	);
}

function lanes(p: ParentPlan, files: string[], profile?: LaneProfile) {
	if (!profile || !childLanes(p, files, profile)) return [];
	return p.children.map((c): Finding => {
		const { lane, why } = laneOf(p, c, files, profile);
		return {
			rule: "lane",
			level: "info",
			child: c.key,
			message: `${c.key} runs in the ${lane} lane: ${why}`,
		};
	});
}

/**
 * A warning per production file outside a child's touches that imports one of its modules,
 * so the planner widens the touches before the go. Test and generated ripples ride along.
 */
export function rippleWarnings(ripples: Record<string, Ripple[]>): Finding[] {
	return Object.entries(ripples).flatMap(([key, rs]) =>
		rs
			.filter((r) => r.kind === "production")
			.map((r) =>
				warn(
					"ripple",
					`${key} ripples into ${r.file}, which imports a module it touches but sits outside its touches`,
					key,
				),
			),
	);
}

/**
 * `closed` are planned children closed outside the run and not landed: they own no
 * scenario, and what they cite is not checked against the parent. `tickets` holds each
 * ticket's summary and description by key, the parent's included, for the hook warnings.
 */
export function check(
	p: ParentPlan,
	files: string[],
	closed: string[] = [],
	maxSize: Size = "S",
	profile?: LaneProfile,
	tickets?: Map<string, string>,
	started: string[] = [],
): Finding[] {
	const shut = new Set(closed);
	const begun = new Set(started);
	return [
		...completeness(p),
		...coverage(p, shut),
		...graph(p),
		...overlap(p, files),
		...spine(p, shut),
		...specs(p, shut, begun),
		...hooks(p, shut),
		...(tickets ? hookWarnings(p, tickets, shut) : []),
		...size(p, maxSize),
		...lanes(p, files, profile),
	];
}
