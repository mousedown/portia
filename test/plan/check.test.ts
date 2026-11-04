import { describe, expect, it } from "vitest";
import { check, intersect } from "../../src/plan/check";
import { child, owning, parent, spine } from "../helpers/plan";

const needOn1 = {
	needs: [{ key: "ACME-1", reason: "contract" }],
	blockedBy: ["ACME-1"],
};
const ok = () =>
	owning(parent([spine(), child("ACME-2", needOn1), child("ACME-3", needOn1)]));
const errors = (p = ok(), files: string[] = []) =>
	check(p, files)
		.filter((f) => f.level === "error")
		.map((f) => f.message);

describe("check", () => {
	it("passes a sound plan", () => {
		expect(errors()).toEqual([]);
	});
	it("completeness: flags missing touches and evidence", () => {
		expect(
			errors(
				parent([
					spine(),
					child("ACME-2", { ...needOn1, touches: [], evidence: "" }),
					child("ACME-3", needOn1),
				]),
			),
		).toEqual(
			expect.arrayContaining([
				"ACME-2 has no touches",
				"ACME-2 has no evidence command",
			]),
		);
	});
	it("coverage: an unowned scenario and an unknown ID", () => {
		const p = parent(
			[
				spine({ acceptance: { F1: "a", F2: "b" } }),
				child("ACME-2", { ...needOn1, requirements: ["F1", "F9"] }),
				child("ACME-3", needOn1),
			],
			[
				{ id: "F1", text: "" },
				{ id: "F2", text: "" },
			],
		);
		expect(errors(p)).toEqual(
			expect.arrayContaining([
				"F2 is owned by no child",
				"ACME-2 cites F9, which the parent does not define",
			]),
		);
	});
	it("graph: a need in the same wave, and a need with no Blocks link", () => {
		const p = parent([
			spine(),
			child("ACME-2", needOn1),
			child("ACME-3", { needs: [{ key: "ACME-2", reason: "r" }] }),
		]);
		expect(errors(p)).toEqual(
			expect.arrayContaining([
				"ACME-3 (wave 1) needs ACME-2 (wave 1); a need must be in an earlier wave",
				"ACME-3 needs ACME-2 but the tracker has no 'is blocked by ACME-2' link",
			]),
		);
	});
	it("graph: a satisfied need outside the run is neither missing nor in a later wave", () => {
		const p = {
			...parent([
				spine(),
				child("ACME-2", {
					needs: [{ key: "ACME-90", reason: "r" }],
					blockedBy: ["ACME-90"],
				}),
			]),
			satisfied: ["ACME-90"],
		};
		expect(check(p, []).filter((f) => f.rule === "graph")).toEqual([]);
	});
	it("overlap: two children in one wave share a file", () => {
		const p = parent([
			spine(),
			child("ACME-2", {
				...needOn1,
				touches: ["packages/acme-web/src/lib/onboarding/**"],
			}),
			child("ACME-3", {
				...needOn1,
				touches: ["packages/acme-web/src/lib/onboarding/actions/*.ts"],
			}),
		]);
		expect(errors(p)[0]).toMatch(
			/^ACME-2 and ACME-3 both touch packages\/acme-web\/src\/lib\/onboarding\/actions\/x\.ts in wave 1/,
		);
	});
	it("spine: no wave 0, and a scenario with no acceptance test", () => {
		expect(errors(parent([child("ACME-2"), child("ACME-3")]))).toContain(
			"no wave 0 (spine) child",
		);
		expect(
			errors(
				parent([
					spine({ acceptance: {} }),
					child("ACME-2", needOn1),
					child("ACME-3", needOn1),
				]),
			),
		).toContain("the spine names no failing acceptance test for F1");
	});
	it("size: too big, and a parent with one child", () => {
		expect(
			errors(
				parent([
					spine(),
					child("ACME-2", { ...needOn1, size: "L" }),
					child("ACME-3", needOn1),
				]),
			),
		).toContain("ACME-2 is size L; children must be XS or S (P6)");
		expect(errors(parent([spine()]))).toContain(
			"only one child: one worker can finish this, so it is declined (Y2)",
		);
	});
	it("size: a profile's maxSize raises the limit", () => {
		const p = parent([
			spine(),
			child("ACME-2", { ...needOn1, size: "L" }),
			child("ACME-3", needOn1),
		]);
		const sizeErrors = (max: "S" | "M" | "L") =>
			check(p, [], [], max)
				.filter((f) => f.level === "error" && f.rule === "size")
				.map((f) => f.message);
		expect(sizeErrors("L")).toEqual([]);
		expect(sizeErrors("M")).toEqual([
			"ACME-2 is size L; children must be XS, S or M (P6)",
		]);
	});
});

describe("intersect", () => {
	it("finds a shared real file first", () => {
		expect(intersect(["a/**"], ["a/b.ts"], ["a/b.ts", "c.ts"])).toBe("a/b.ts");
	});
	it("returns null for disjoint globs", () => {
		expect(intersect(["a/**"], ["b/**"], ["a/x", "b/y"])).toBeNull();
	});
});

describe("a spine that owns a scenario no later child can deliver", () => {
	// The foundation ticket holds the shared record every other ticket needs, so it is
	// the spine, and it is also the only ticket that delivers R1.
	const scenarios = ["R1", "R2", "R3", "R4"].map((id) => ({ id, text: id }));
	const acceptance = {
		R1: "packages/acme-web/e2e/record.e2e.ts",
		R2: "packages/acme-web/e2e/list.e2e.ts",
		R3: "packages/acme-web/e2e/edit.e2e.ts",
		R4: "packages/acme-web/e2e/export.e2e.ts",
	};
	const needOn401 = {
		needs: [{ key: "ACME-401", reason: "the shared record" }],
		blockedBy: ["ACME-401"],
	};
	const plan = (spineOwns: string[], r2Owners = ["ACME-402"]) =>
		owning(
			parent(
				[
					spine({ key: "ACME-401", requirements: spineOwns, acceptance }),
					child("ACME-402", {
						...needOn401,
						requirements: r2Owners.includes("ACME-402") ? ["R2"] : [],
					}),
					child("ACME-403", { ...needOn401, requirements: ["R3"] }),
					child("ACME-404", {
						...needOn401,
						wave: 2,
						needs: [{ key: "ACME-403", reason: "edits" }],
						blockedBy: ["ACME-403"],
						requirements: ["R4"],
					}),
				],
				scenarios,
			),
		);

	it("passes the plan check with the spine owning R1", () => {
		expect(check(plan(["R1"]), [])).toEqual([]);
	});
	it("still fails a scenario nobody owns", () => {
		expect(errors(plan([]))).toEqual(["R1 is owned by no child"]);
	});
	it("warns when the spine shares a scenario with a later child", () => {
		const findings = check(plan(["R1", "R2"]), []);
		expect(findings.filter((f) => f.level === "error")).toEqual([]);
		expect(findings).toEqual([
			{
				rule: "coverage",
				level: "warn",
				child: "ACME-401",
				message:
					"R2 is owned by the spine ACME-401 and by ACME-402: the spine's gate leaves it to them; the spine should own only a scenario no later child can deliver",
			},
		]);
	});
	it("refuses a spine requirement the parent does not define", () => {
		expect(errors(plan(["R1", "R9"]))).toEqual([
			"ACME-401 cites R9, which the parent does not define",
		]);
	});
});

describe("children closed outside the run", () => {
	const scenarios = [
		{ id: "F1", text: "one" },
		{ id: "F2", text: "two" },
	];
	it("own no scenario, and their citations raise nothing", () => {
		const p = owning(
			parent(
				[
					spine({
						acceptance: {
							F1: "packages/acme-web/e2e/a.e2e.ts",
							F2: "packages/acme-web/e2e/b.e2e.ts",
						},
					}),
					child("ACME-2", { ...needOn1, requirements: ["F1"] }),
					child("ACME-3", { ...needOn1, requirements: ["F2", "F9"] }),
				],
				scenarios,
			),
		);
		expect(
			check(p, [], ["ACME-3"])
				.filter((f) => f.level === "error")
				.map((f) => f.message),
		).toEqual(["F2 is owned by no child"]);
		expect(errors(p)).toEqual([
			"ACME-3 cites F9, which the parent does not define",
		]);
	});
	it("a closed spine's acceptance tests own no scenario", () => {
		const p = parent([
			spine(),
			child("ACME-2", needOn1),
			child("ACME-3", needOn1),
		]);
		expect(
			check(p, [], ["ACME-1"])
				.filter((f) => f.level === "error")
				.map((f) => f.message),
		).toEqual(["the spine names no failing acceptance test for F1"]);
	});
});

describe("specs: each acceptance spec sits inside its owner's touches", () => {
	// The ACME-500 shape the eval ran: every spec and a helper in specs/acceptance/, which
	// the spine alone touched and no ticket declared.
	const features = ["delivery", "pricing", "surcharge", "orders"];
	const scenarios = features.map((_, i) => ({ id: `R${i + 1}`, text: "t" }));
	const needOn501 = {
		needs: [{ key: "ACME-501", reason: "the delivery record" }],
		blockedBy: ["ACME-501"],
	};
	const plan = (spec: (id: string, feature: string) => string) => {
		const acceptance = Object.fromEntries(
			features.map((f, i) => [`R${i + 1}`, spec(`R${i + 1}`, f)]),
		);
		return parent(
			[
				spine({
					key: "ACME-501",
					requirements: ["R1"],
					touches: [
						"src/delivery/**",
						"specs/delivery/**",
						...Object.values(acceptance).filter(
							(p) => !p.startsWith("specs/delivery/"),
						),
					],
					acceptance,
				}),
				...features.slice(1).map((f, i) =>
					child(`ACME-50${i + 2}`, {
						...needOn501,
						touches: [`src/${f}/**`, `specs/${f}/**`],
						requirements: [`R${i + 2}`],
					}),
				),
			],
			scenarios,
		);
	};
	const specErrors = (p: ReturnType<typeof plan>) =>
		check(p, [])
			.filter((f) => f.rule === "specs")
			.map((f) => f.message);

	it("refuses specs in a directory only the spine touches", () => {
		const shared = plan((id) => `specs/acceptance/${id.toLowerCase()}.test.ts`);
		const found = specErrors(shared);
		// R1 is the spine's own scenario, and its touches hold specs/acceptance/r1.test.ts.
		expect(found).toHaveLength(3);
		expect(found[0]).toBe(
			"R2's spec specs/acceptance/r2.test.ts sits outside the touches of ACME-502 (src/pricing/**, specs/pricing/**), which owns R2: put it under the owner's paths, for example specs/pricing/r2.test.ts, and list that path in ACME-501's touches",
		);
		expect(errors(shared)).toEqual(expect.arrayContaining(found));
	});
	it("does not hold a started owner to it, since a started child is never re-planned", () => {
		const shared = plan((id) => `specs/acceptance/${id.toLowerCase()}.test.ts`);
		const keys = shared.children.map((c) => c.key);
		expect(
			check(shared, [], [], "S", undefined, undefined, keys).filter(
				(f) => f.rule === "specs",
			),
		).toEqual([]);
	});
	it("still holds an owner not started yet when its scenario's other owners have started", () => {
		const shared = plan((id) => `specs/acceptance/${id.toLowerCase()}.test.ts`);
		const later = child("ACME-599", {
			...needOn501,
			touches: ["src/late/**", "specs/late/**"],
			requirements: ["R2"],
		});
		const withLate = { ...shared, children: [...shared.children, later] };
		const begun = shared.children.map((c) => c.key);
		const found = check(withLate, [], [], "S", undefined, undefined, begun)
			.filter((f) => f.rule === "specs")
			.map((f) => f.message);
		expect(found).toEqual([
			expect.stringContaining("ACME-599 (src/late/**, specs/late/**)"),
		]);
	});
	it("passes specs under each owner's specs/<feature>/", () => {
		expect(specErrors(plan((id, f) => `specs/${f}/${id}.accept.ts`))).toEqual(
			[],
		);
	});
	it("refuses a spec the spine's touches do not hold", () => {
		const p = plan((id, f) => `specs/${f}/${id}.accept.ts`);
		const [s] = p.children;
		if (s) s.touches = ["src/delivery/**", "specs/delivery/**"];
		expect(specErrors(p)).toEqual([
			"the spine ACME-501 writes R2's spec specs/pricing/R2.accept.ts, which its touches do not hold: list specs/pricing/R2.accept.ts in its touches",
			"the spine ACME-501 writes R3's spec specs/surcharge/R3.accept.ts, which its touches do not hold: list specs/surcharge/R3.accept.ts in its touches",
			"the spine ACME-501 writes R4's spec specs/orders/R4.accept.ts, which its touches do not hold: list specs/orders/R4.accept.ts in its touches",
		]);
	});
	it("accepts a spec shared by two owners when it sits inside one of them", () => {
		const p = owning(
			parent([spine(), child("ACME-2", needOn1), child("ACME-3", needOn1)]),
		);
		expect(p.children[1]?.touches).toContain("packages/acme-web/e2e/a.e2e.ts");
		expect(check(p, []).filter((f) => f.rule === "specs")).toEqual([]);
	});
});

describe("hook: the spine scaffolds the plug-in point between two children", () => {
	const scenarios = [
		{ id: "R1", text: "manifest" },
		{ id: "R2", text: "price" },
		{ id: "R3", text: "surcharge" },
	];
	const specs = {
		R1: "specs/delivery/R1.accept.ts",
		R2: "specs/pricing/R2.accept.ts",
		R3: "specs/surcharge/R3.accept.ts",
	};
	const plan = (hooks?: Record<string, string>, spineTouches: string[] = []) =>
		parent(
			[
				spine({
					key: "ACME-401",
					requirements: ["R1"],
					touches: [
						"src/delivery/**",
						"specs/delivery/**",
						specs.R2,
						specs.R3,
						...spineTouches,
					],
					acceptance: specs,
					hooks,
				}),
				child("ACME-402", {
					needs: [{ key: "ACME-401", reason: "the delivery" }],
					blockedBy: ["ACME-401"],
					touches: ["src/pricing/**", "specs/pricing/**"],
					requirements: ["R2"],
				}),
				child("ACME-403", {
					wave: 2,
					needs: [{ key: "ACME-402", reason: "surcharge applies when priced" }],
					blockedBy: ["ACME-402"],
					touches: ["src/surcharge/**", "specs/surcharge/**"],
					requirements: ["R3"],
				}),
			],
			scenarios,
		);
	// The ACME-400 tickets as the eval wrote them, reduced to the routes they name.
	const tickets = new Map([
		["ACME-0", "One delivery per paid order, at `/deliveries/:id`."],
		[
			"ACME-401",
			"Manifest\n`POST /orders/:id/deliveries` and `GET /deliveries/:id`",
		],
		[
			"ACME-402",
			"Price\n`POST /deliveries/:id/price` sets surchargeCents; `GET /deliveries/:id` then shows it.",
		],
		[
			"ACME-403",
			"Surcharge\nWhen a delivery is priced (`POST /deliveries/:id/price`), surchargeCents is the county's.",
		],
	]);
	const hookFindings = (p: ReturnType<typeof plan>) =>
		check(p, [], [], "S", undefined, tickets).filter((f) => f.rule === "hook");

	it("warns when two children's tickets meet at a route and no hook covers it", () => {
		expect(hookFindings(plan())).toEqual([
			{
				rule: "hook",
				level: "warn",
				child: "ACME-403",
				message:
					"ACME-403 and ACME-402 both name /deliveries/*/price: ACME-403's feature plugs into code ACME-402 owns. Give the plug-in point to the spine: a 'hook: <file> # <the stub>' line on ACME-401, with the file in ACME-403's touches, which ACME-402 calls and ACME-403 fills, so neither edits the other's files",
			},
		]);
	});
	it("is quiet once the spine scaffolds a hook in the filler's touches", () => {
		const p = plan(
			{
				"src/surcharge/rules.ts":
					"surchargeCents(county, priceCents) returns 0",
			},
			["src/surcharge/rules.ts"],
		);
		expect(hookFindings(p)).toEqual([]);
		expect(errors(p)).toEqual([]);
	});
	it("warns on a file one ticket names under the other's touches", () => {
		const t = new Map([
			["ACME-402", "Price\nCall `src/surcharge/rules.ts` for the surcharge."],
			["ACME-403", "Surcharge\nThe county table."],
		]);
		expect(
			check(plan(), [], [], "S", undefined, t)
				.filter((f) => f.rule === "hook")
				.map((f) => f.message),
		).toEqual([
			expect.stringMatching(
				/^ACME-403 and ACME-402 meet at src\/surcharge\/rules\.ts: ACME-403's feature plugs into code ACME-402 owns/,
			),
		]);
	});
	it("refuses a hook outside the spine's touches, or on a later child", () => {
		const p = plan({ "src/surcharge/rules.ts": "stub" });
		const later = p.children[1];
		if (later) later.hooks = { "src/pricing/hook.ts": "" };
		expect(errors(p)).toEqual([
			"the spine ACME-401 scaffolds the hook src/surcharge/rules.ts, which its touches do not hold: list src/surcharge/rules.ts in its touches",
			"ACME-402 names the hook src/pricing/hook.ts, but only the spine scaffolds hooks: move the line to the wave 0 block",
		]);
	});
	it("warns about a hook no later child fills", () => {
		const p = plan({ "src/shared/hook.ts": "" }, ["src/shared/**"]);
		expect(hookFindings(p).map((f) => f.message)).toContain(
			"the hook src/shared/hook.ts is in no later child's touches, so no child fills it: it belongs in the touches of the child whose feature plugs in there",
		);
	});
});
