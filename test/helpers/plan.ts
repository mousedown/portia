import type { ChildPlan, ParentPlan, Scenario } from "../../src/core/types";

export const child = (key: string, o: Partial<ChildPlan> = {}): ChildPlan => ({
	key,
	summary: key,
	wave: 1,
	needs: [],
	touches: [`packages/acme-web/src/${key}/**`],
	requirements: ["F1"],
	evidence: `bun run test -- ${key}`,
	tier: "standard",
	size: "S",
	acceptance: {},
	blockedBy: [],
	...o,
});
export const spine = (o: Partial<ChildPlan> = {}) =>
	child("ACME-1", {
		wave: 0,
		requirements: [],
		acceptance: { F1: "packages/acme-web/e2e/a.e2e.ts" },
		...o,
	});
export const parent = (
	children: ChildPlan[],
	scenarios: Scenario[] = [{ id: "F1", text: "t" }],
): ParentPlan => ({
	key: "ACME-0",
	summary: "p",
	scope: "onboarding",
	scenarios,
	children,
});
/**
 * `p` with each spine spec path added to the spine's touches and to the touches of the
 * first child owning its scenario, so it passes the `specs` rule.
 */
export const owning = (p: ParentPlan): ParentPlan => {
	const specs = Object.entries(
		Object.assign(
			{},
			...p.children.filter((c) => c.wave === 0).map((c) => c.acceptance),
		),
	) as [string, string][];
	const owner = (id: string) =>
		p.children.find((c) => c.wave > 0 && c.requirements.includes(id)) ??
		p.children.find((c) => c.wave === 0 && c.requirements.includes(id));
	return {
		...p,
		children: p.children.map((c) => {
			const extra = specs
				.filter(([id]) => c.wave === 0 || owner(id)?.key === c.key)
				.map(([, path]) => path)
				.filter((path) => !c.touches.includes(path));
			return extra.length ? { ...c, touches: [...c.touches, ...extra] } : c;
		}),
	};
};
