import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChildPlan, ParentPlan } from "../../src/core/types";
import {
	couplingWarnings,
	routeShape,
	specCoupling,
	textRoutes,
} from "../../src/plan/coupling";

function checkout(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "portia-coupling-"));
	for (const [f, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, f)), { recursive: true });
		writeFileSync(join(root, f), body);
	}
	return { root, files: Object.keys(files) };
}

const child = (c: Partial<ChildPlan> & Pick<ChildPlan, "key">): ChildPlan => ({
	summary: "",
	wave: 1,
	needs: [],
	touches: [],
	requirements: [],
	evidence: "bun test",
	tier: "standard",
	acceptance: {},
	blockedBy: [],
	...c,
});
const need = (key: string) => ({ key, reason: "r" });
/** Source text with each `#{` read as the `${` of a template literal, so it stays a plain string. */
const src = (s: string) => s.replaceAll("#{", "${");

/** A spine with every spec, then pricing, a surcharge on top of it, and order history. */
function plan(historyNeeds: string[]): ParentPlan {
	return {
		key: "PROJ-1",
		summary: "",
		scope: "shop",
		scenarios: ["F1", "F2", "F3", "F4"].map((id) => ({ id, text: id })),
		children: [
			child({
				key: "PROJ-2",
				wave: 0,
				touches: ["src/delivery/**", "specs/delivery/**"],
				requirements: ["F1"],
				acceptance: {
					F1: "specs/delivery/F1.accept.ts",
					F2: "specs/pricing/F2.accept.ts",
					F3: "specs/surcharge/F3.accept.ts",
					F4: "specs/history/F4.accept.ts",
				},
			}),
			child({
				key: "PROJ-3",
				needs: [need("PROJ-2")],
				touches: ["src/pricing/**", "specs/pricing/**"],
				requirements: ["F2"],
			}),
			child({
				key: "PROJ-4",
				wave: 2,
				needs: [need("PROJ-3")],
				touches: ["src/surcharge/**", "specs/surcharge/**"],
				requirements: ["F3"],
			}),
			child({
				key: "PROJ-5",
				wave: 2,
				needs: historyNeeds.map(need),
				touches: ["src/history/**", "specs/history/**"],
				requirements: ["F4"],
			}),
		],
	};
}

const tickets = new Map([
	["PROJ-2", "Manifest\nA delivery at `/deliveries/:id`."],
	[
		"PROJ-3",
		"Price\nWhen a delivery is priced (`POST /deliveries/:id/price`).",
	],
	[
		"PROJ-4",
		"Surcharge\nWhen a delivery is priced (`POST /deliveries/:id/price`), add the county surcharge.",
	],
	[
		"PROJ-5",
		"History\n`GET /customers/:id/orders`, each as `GET /orders/:id`.",
	],
]);

const SPECS = {
	"src/orders/routes.ts":
		'export const routes = [{ path: "/orders/:id" }, { path: "/orders" }];\n',
	"specs/delivery/F1.accept.ts": 'await post("/orders/1/deliveries");\n',
	"specs/pricing/F2.accept.ts": src(
		"await post(`/deliveries/#{d.id}/price`);\n",
	),
	"specs/surcharge/F3.accept.ts": src(
		"await post(`/deliveries/#{d.id}/price`);\n",
	),
	"specs/history/F4.accept.ts": [
		'import { shop } from "../support/shop";',
		src("await post(`/deliveries/#{d.id}/price`);"),
		src("await get(`/customers/#{c.id}/orders`);"),
		src("await get(`/orders/#{o.id}`);"),
	].join("\n"),
};

describe("routeShape", () => {
	it("makes every parameter a wildcard and drops query, hash and trailing punctuation", () => {
		expect(routeShape(src("/orders/#{o.id}/pay?x=1"))).toEqual([
			"orders",
			"*",
			"pay",
		]);
		expect(routeShape("/Orders/:id.")).toEqual(["orders", "*"]);
		expect(routeShape("/orders/{id}#top")).toEqual(["orders", "*"]);
	});

	it("reads routes from prose but not from relative paths or URLs", () => {
		expect(
			textRoutes(
				"`GET /orders/:id`, paths `src/orders/**`, see https://x.io/a and and/or",
			),
		).toEqual(["/orders/:id"]);
	});
});

describe("specCoupling", () => {
	it("flags a spec that requests a route another child's ticket names, which its owner does not need", () => {
		const { root, files } = checkout(SPECS);
		const found = specCoupling(
			plan(["PROJ-2", "PROJ-3"]),
			tickets,
			root,
			files,
		);
		expect(found).toEqual([
			{
				scenario: "F4",
				spec: "specs/history/F4.accept.ts",
				owner: "PROJ-5",
				other: "PROJ-4",
				via: "route",
				target: src("/deliveries/#{d.id}/price"),
			},
		]);
		expect(couplingWarnings(found)[0]).toMatchObject({
			rule: "coupling",
			level: "warn",
			child: "PROJ-5",
		});
		expect(couplingWarnings(found)[0]?.message).toContain(
			"PROJ-5 (owner of F4) does not need PROJ-4",
		);
	});

	it("counts a need of a need as met, and a route the owner's own ticket names as its own", () => {
		const { root, files } = checkout(SPECS);
		// PROJ-4 needs PROJ-3, so a need on PROJ-4 covers both; F2's own ticket names the price route.
		expect(specCoupling(plan(["PROJ-4"]), tickets, root, files)).toEqual([]);
	});

	it("ignores a route the checkout already serves outside the other child's touches", () => {
		const { root, files } = checkout({
			...SPECS,
			"src/delivery/price.ts": 'router.post("/deliveries/:id/price");\n',
		});
		expect(
			specCoupling(plan(["PROJ-2", "PROJ-3"]), tickets, root, files),
		).toEqual([]);
	});

	it("still flags a route that only a test helper the specs import requests", () => {
		const { root, files } = checkout({
			...SPECS,
			"specs/delivery/support.ts": src(
				"export const price = (shop, id) => shop.post(`/deliveries/#{id}/price`);\n",
			),
			"specs/history/F4.accept.ts": src(
				`import { price } from "../delivery/support";\n${SPECS["specs/history/F4.accept.ts"]}`,
			),
			"src/delivery/price.test.ts": src(
				"await post(`/deliveries/#{id}/price`);\n",
			),
		});
		expect(
			specCoupling(plan(["PROJ-2"]), tickets, root, files).map((c) => [
				c.scenario,
				c.other,
				c.via,
			]),
		).toContainEqual(["F4", "PROJ-3", "route"]);
	});

	it("flags a spec that imports a module under another child's touches, existing or not", () => {
		const { root, files } = checkout({
			"tsconfig.json":
				'{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }',
			"specs/delivery/F1.accept.ts": "\n",
			"specs/pricing/F2.accept.ts": "\n",
			"specs/surcharge/F3.accept.ts":
				'import { rate } from "@/surcharge/rate";\n',
			"specs/history/F4.accept.ts": [
				'import { list } from "../../src/history/list";',
				'import { rate } from "../../src/surcharge/rate.js";',
			].join("\n"),
		});
		expect(
			specCoupling(plan(["PROJ-2", "PROJ-3"]), new Map(), root, files),
		).toEqual([
			{
				scenario: "F4",
				spec: "specs/history/F4.accept.ts",
				owner: "PROJ-5",
				other: "PROJ-4",
				via: "import",
				target: "../../src/surcharge/rate.js",
			},
		]);
	});

	it("leaves a closed child out, and reads a spec the spine owns against every later child", () => {
		const { root, files } = checkout({
			...SPECS,
			"specs/delivery/F1.accept.ts": src(
				"await post(`/deliveries/#{d.id}/price`);\n",
			),
		});
		const p = plan(["PROJ-2", "PROJ-3", "PROJ-4"]);
		expect(
			specCoupling(p, tickets, root, files).map((c) => [c.owner, c.other]),
		).toEqual([
			["PROJ-2", "PROJ-3"],
			["PROJ-2", "PROJ-4"],
		]);
		expect(
			specCoupling({ ...p, closed: ["PROJ-4"] }, tickets, root, files).map(
				(c) => [c.owner, c.other],
			),
		).toEqual([["PROJ-2", "PROJ-3"]]);
	});
});
