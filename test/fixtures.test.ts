import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { check } from "../src/plan/check";
import { Jira } from "../src/plan/jira";
import { loadPlan } from "../src/plan/load";
import { ownedScenarios, readyScenarios } from "../src/plan/owned";
import { topLevelOf } from "../src/plan/repo";
import { JiraTracker } from "../src/plan/tracker";
import { fakeFetch } from "./helpers/fake-fetch";

const dir = join(__dirname, "fixtures", "jira");
const keys = existsSync(dir)
	? readdirSync(dir)
			.filter((f) => /^[A-Z]+-\d+\.json$/.test(f))
			.map((f) => f.replace(".json", ""))
			.filter((k) => existsSync(join(dir, `${k}-children.json`)))
	: [];
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));

// Skipped until scripts/record-fixtures.ts has recorded a plan.
it.skipIf(keys.length === 0)(
	"every recorded Jira plan still loads and checks clean",
	async () => {
		for (const key of keys) {
			const tracker = new JiraTracker(
				new Jira(
					{ baseUrl: "https://x", email: "e", token: "t" },
					fakeFetch({
						[`/issue/${key}`]: read(`${key}.json`),
						"/search/jql": { issues: read(`${key}-children.json`) },
					}),
				),
			);
			const { plan, findings } = await loadPlan(
				tracker,
				key,
				topLevelOf(["packages/acme-web/package.json"]),
				"packages/acme-web",
			);
			// The recorded plans predate the specs rule: they keep several scenarios in one e2e
			// file outside every owner's touches, which a plan written now must not.
			const errors = [...findings, ...check(plan, [])].filter(
				(f) => f.level === "error" && f.rule !== "specs",
			);
			expect(errors, key).toEqual([]);
		}
	},
);

const sv2605 = existsSync(join(dir, "ACME-500-children.json"));
it.skipIf(!sv2605)(
	"ACME-500: A (ACME-502) owns the spine's specs for its scenarios",
	async () => {
		const tracker = new JiraTracker(
			new Jira(
				{ baseUrl: "https://x", email: "e", token: "t" },
				fakeFetch({
					"/issue/ACME-500": read("ACME-500.json"),
					"/search/jql": { issues: read("ACME-500-children.json") },
				}),
			),
		);
		const { plan } = await loadPlan(
			tracker,
			"ACME-500",
			topLevelOf(["packages/acme-web/package.json"]),
			"packages/acme-web",
		);
		const [a] = plan.children.filter((c) => c.key === "ACME-502");
		const [spine] = plan.children.filter((c) => c.wave === 0);
		if (!a || !spine) throw new Error("ACME-500 lost its spine or A");
		expect(ownedScenarios(plan, a)).toEqual([
			{ id: "F1", path: "packages/acme-web/e2e/onboarding/checklist.e2e.ts" },
			{ id: "F3", path: "packages/acme-web/e2e/onboarding/checklist.e2e.ts" },
		]);
		expect(ownedScenarios(plan, spine)).toEqual([]);
	},
);

it.skipIf(!sv2605)(
	"ACME-500: A, B and C share F1/F3; only the last of them to land runs them",
	async () => {
		const tracker = new JiraTracker(
			new Jira(
				{ baseUrl: "https://x", email: "e", token: "t" },
				fakeFetch({
					"/issue/ACME-500": read("ACME-500.json"),
					"/search/jql": { issues: read("ACME-500-children.json") },
				}),
			),
		);
		const { plan } = await loadPlan(
			tracker,
			"ACME-500",
			topLevelOf(["packages/acme-web/package.json"]),
			"packages/acme-web",
		);
		const byKey = (k: string) => {
			const c = plan.children.find((x) => x.key === k);
			if (!c) throw new Error(`ACME-500 lost ${k}`);
			return c;
		};
		const landed = (child: string) => ({
			at: "t",
			child,
			attempt: 1,
			stage: "landed" as const,
			status: "landed",
		});
		for (const k of ["ACME-502", "ACME-503", "ACME-504"]) {
			const ids = readyScenarios(plan, byKey(k), []).ready.map((o) => o.id);
			expect(ids, k).not.toContain("F1");
			expect(ids, k).not.toContain("F3");
		}
		const c = readyScenarios(plan, byKey("ACME-504"), [
			landed("ACME-502"),
			landed("ACME-503"),
		]);
		expect(c.ready.map((o) => o.id)).toEqual(["F1", "F3", "F4"]);
		expect(c.waiting).toEqual([]);
	},
);
