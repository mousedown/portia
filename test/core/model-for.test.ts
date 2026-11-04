import { expect, it } from "vitest";
import { modelFor } from "../../src/core/config";

const models = { high: "opus", standard: "sonnet" };

it("runs a small standard child on the small model, and everything else on its tier's", () => {
	const p = { models: { ...models, small: "haiku" } };
	expect(modelFor(p, { tier: "standard", wave: 1, size: "XS" })).toBe("haiku");
	expect(modelFor(p, { tier: "standard", wave: 2, size: "S" })).toBe("haiku");
	expect(modelFor(p, { tier: "standard", wave: 1, size: "M" })).toBe("sonnet");
	expect(modelFor(p, { tier: "standard", wave: 1 })).toBe("sonnet");
	expect(modelFor(p, { tier: "high", wave: 1, size: "M" })).toBe("opus");
	// The spine sets the contract every child builds on: never the small model.
	expect(modelFor(p, { tier: "standard", wave: 0, size: "XS" })).toBe("sonnet");
});

it("runs a small child the planner called high on the small model, unless it touches a sensitive path", () => {
	const p = {
		models: { ...models, small: "haiku" },
		sensitiveGlobs: ["src/billing/**", "migrations/*.sql"],
	};
	expect(
		modelFor(p, {
			tier: "high",
			wave: 3,
			size: "S",
			touches: ["src/refunds/**", "specs/refunds/**"],
		}),
	).toBe("haiku");
	expect(
		modelFor(p, {
			tier: "high",
			wave: 1,
			size: "XS",
			touches: ["src/billing/**"],
		}),
	).toBe("opus");
	expect(
		modelFor(p, {
			tier: "high",
			wave: 1,
			size: "S",
			touches: ["src/billing/ledger.ts"],
		}),
	).toBe("opus");
	expect(
		modelFor(p, {
			tier: "high",
			wave: 1,
			size: "S",
			touches: ["migrations/**"],
		}),
	).toBe("opus");
	// A sensitive touch does not lift a standard child off the small model.
	expect(
		modelFor(p, {
			tier: "standard",
			wave: 1,
			size: "S",
			touches: ["src/billing/**"],
		}),
	).toBe("haiku");
});

it("leaves every child on its tier's model when the profile names no small one", () => {
	expect(modelFor({ models }, { tier: "standard", wave: 1, size: "XS" })).toBe(
		"sonnet",
	);
	expect(
		modelFor({ models }, { tier: "high", wave: 1, size: "XS", touches: [] }),
	).toBe("opus");
});
