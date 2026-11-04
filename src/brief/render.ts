import picomatch from "picomatch";
import { PortiaProblem } from "../core/exit";
import type { ProfileLocation } from "../core/profile-file";
import type { ChildPlan, ParentPlan } from "../core/types";
import { parseDesignRef } from "../design/ref";
import type { WorkerEnv } from "../env/env";
import { PLAN_BLOCK } from "../plan/block";
import { ownedScenarios } from "../plan/owned";
import type { TrackerIssue } from "../plan/tracker";

/** The ticket's description as the worker reads it: everything but the plan block. */
export function ticketText(description: string): string {
	return description.replace(PLAN_BLOCK, "").trim();
}

/**
 * The spine writes a failing spec for every scenario, but what a later child's spec asserts
 * (its values, routes and shapes) is in that child's ticket. Each later child listing one of
 * the spine's scenarios, once, with its ticket as the tracker holds it. Empty for any other child.
 */
export function scenarioTickets(
	plan: ParentPlan,
	c: ChildPlan,
	issues: Pick<TrackerIssue, "key" | "summary" | "description">[],
): string {
	if (c.wave !== 0) return "";
	const ids = new Set(plan.scenarios.map((s) => s.id));
	const tickets = plan.children.flatMap((x) => {
		const mine = x.requirements.filter((id) => ids.has(id));
		const issue = issues.find((i) => i.key === x.key);
		return x.wave !== 0 && mine.length && issue
			? [
					`### ${x.key}: ${issue.summary} (${mine.join(", ")})\n\n${ticketText(issue.description)}`,
				]
			: [];
	});
	return tickets.length
		? `\n## The tickets whose scenarios you write\n\nThe children that deliver your failing tests. Each test asserts what its child's ticket says, so take the contract's values, routes and shapes from these.\n\n${tickets.join("\n\n")}\n`
		: "";
}

export function fill(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
		const v = vars[k];
		if (v === undefined)
			throw new PortiaProblem(`the brief template needs '${k}'`);
		return v;
	});
}

/** A path as one shell word: single-quoted only when it needs to be. */
function shellWord(s: string): string {
	return /^[\w./~-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * The brief's Environment section: how to run portia so it loads the orchestrator's
 * profile (when that did not come from the repo's own portia.config.ts, which the
 * worktree has too), then the profile's notes. Empty when there is neither.
 */
export function environmentSection(
	notes: string[],
	profileFile?: ProfileLocation,
): string {
	const lines = [
		...(profileFile && profileFile.via !== "repo"
			? [
					`Run every portia command as \`PORTIA_PROFILE=${shellWord(profileFile.file)} portia …\`, so it loads the same profile as the orchestrator.`,
				]
			: []),
		...notes,
	];
	return lines.length
		? `\n## Environment\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`
		: "";
}

/** What the spine's role adds for the scenarios it owns: those it must make pass itself. */
const spineOwns = (owned: Map<string, string>) => {
	const ids = [...owned.keys()];
	return ids.length
		? ` You also own ${listed(ids)}: no later child can deliver ${ids.length > 1 ? "them" : "it"}, so make ${ids.length > 1 ? "their tests" : "its test"} pass here; your exit gate runs ${ids.length > 1 ? "them" : "it"}. Every other test must still fail.`
		: "";
};
/** What the spine's role adds when the plan names hooks: it creates each one. */
const spineHooks = (c: ChildPlan) => {
	const n = Object.keys(c.hooks ?? {}).length;
	return n
		? ` Create the ${n > 1 ? `${n} hook modules` : "hook module"} under Hooks as stubs.`
		: "";
};
const listed = (xs: string[]) =>
	xs.length < 2
		? xs.join("")
		: `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/**
 * The plan's hooks as the brief's Hooks section. The spine scaffolds each one; the child
 * whose touches hold it fills it, and every other child calls it as it stands. Empty
 * when the plan names none.
 */
export function hooksSection(plan: ParentPlan, c: ChildPlan): string {
	const hooks = plan.children
		.filter((x) => x.wave === 0)
		.flatMap((x) => Object.entries(x.hooks ?? {}));
	if (!hooks.length) return "";
	const mine = picomatch(c.touches, { dot: true });
	const line = ([path, note]: [string, string]) =>
		`- ${path}${note ? `: ${note}` : ""}${c.wave === 0 ? "" : mine(path) ? " (yours to fill)" : " (call it; never edit it)"}`;
	const lead =
		c.wave === 0
			? "Each is a plug-in point between two children's features. Create every one as a stub module both sides can use now (its exported functions and types, returning the neutral value the note names), so no child has to edit a sibling's file."
			: "The spine scaffolded these stub modules where one child's feature plugs into another's. Fill a hook inside your touches in place; call the others as they stand, and never write a stand-in for one in your own files.";
	return `\n## Hooks\n\n${lead}\n\n${hooks.map(line).join("\n")}\n`;
}

/**
 * How a child says a spec of its own scenarios cannot pass as written: a `spec` in its result,
 * which sends the spec back to the spine to amend instead of round the park loop. Empty for
 * the spine, and for a child that owns no spec.
 */
export function claimSection(owned: Map<string, string>): string {
	if (!owned.size) return "";
	return `\n## If a spec you own cannot pass\n\nThe acceptance specs are signed off: never edit one to make it pass. If you can show that one of yours (${[...owned.values()].join(", ")}) cannot pass as written whatever the implementation (its test code throws, or an assertion the repository's test runner cannot satisfy as installed), do not ask about it: finish with status "parked" and add \`"spec":{"path":"<the spec>","assertion":"<the assertion that cannot pass>","evidence":"<the command, its output, and what shows a correct implementation still fails it>"}\` to your result. Check the claim first: run the spec, quote the failing assertion and its output, and show why no correct implementation can satisfy it, not only that yours does not yet. A spec that fails because another child's feature has not landed (a route, a module or a hook its ticket delivers) is no claim: park naming that child's key instead. The spec goes back to the spine to amend, and you are dispatched again onto the amended spec.\n`;
}

export function briefVars(
	plan: ParentPlan,
	c: ChildPlan,
	env: WorkerEnv,
	description: string,
	personas: Record<string, string> = {},
	previous = "",
	environment = "",
	answers = "",
	resultFile?: string,
	tickets = "",
): Record<string, string> {
	const spine = c.wave === 0;
	const owned = new Map(
		ownedScenarios(plan, c).map((o) => [o.id, o.path] as const),
	);
	const scenarios = (
		spine
			? plan.scenarios
			: plan.scenarios.filter((s) => c.requirements.includes(s.id))
	)
		.map((s) => {
			const path = spine ? c.acceptance[s.id] : owned.get(s.id);
			const where = spine && !owned.has(s.id) ? "failing test in" : "test in";
			return `- ${s.id}: ${s.text}${path ? ` (${where} ${path})` : ""}`;
		})
		.join("\n");
	const design = c.design
		? [
				"",
				`## Design (frames ${parseDesignRef(c.design).frames.join(", ")})`,
				"",
				"- Build only from design-system tokens and existing components; lint rejects raw colours and arbitrary values (V7). A new component or token belongs in the spine: park if you need one.",
				"- Your exit gate compares the page with the design. FAIL (a found element with the wrong style, or a page showing under half the designed elements) blocks; fix it. UNCERTAIN (pixel differences, or a designed element not found, often mock data your DB lacks) is reported for a person to judge — don't bend the page to match mock data.",
				"",
			].join("\n")
		: "";
	const named = [
		...new Set(
			plan.children.flatMap((x) =>
				x.design ? [parseDesignRef(x.design).persona] : [],
			),
		),
	];
	const personaRole = named.length
		? ` Some children have a design line. Export each persona helper it names from the target e2e module (seed a fresh test user the way the repo's e2e does, then sign in): ${named.map((n) => (personas[n] ? `${n} = ${personas[n]} (module relative to e2e/, then #export name)` : n)).join("; ")}. The acceptance tests should reuse these helpers.`
		: "";
	return {
		child: c.key,
		summary: c.summary,
		parent: plan.key,
		worktree: env.worktree,
		branch: env.branch,
		envFile: env.envFile,
		port: String(env.port),
		description,
		tickets,
		answers,
		scenarios,
		touches: c.touches.map((t) => `- ${t}`).join("\n"),
		hooks: hooksSection(plan, c),
		claim: spine ? "" : claimSection(owned),
		evidence: c.evidence,
		design,
		previous: previous ? `\n${previous}` : "",
		environment,
		resultFile: resultFile
			? `\nBefore you send it, write the same object to \`${resultFile}\`: you run detached, and the orchestrator reads your result from that file.\n`
			: "",
		role: spine
			? `You are the spine: land the shared contract and write every scenario as a failing end-to-end test at its path. The tests must fail now and pass once the feature is complete. Start each test's title with its scenario id ("F2: …"): each child's exit gate runs its own scenarios by id. Every test path is in your touches; a helper the tests share goes inside your touches too.${spineHooks(c)}${spineOwns(owned)}${personaRole}`
			: `You build one wave ${c.wave} child on top of the spine.`,
	};
}
