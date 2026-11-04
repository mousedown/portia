import { describe, expect, it } from "vitest";
import { BlockError, parseChild, parseParent } from "../../src/plan/block";

const raw = (body: string) => ({
	key: "ACME-1",
	summary: "s",
	blockedBy: [],
	description: `\`\`\`plan\n${body}\n\`\`\``,
});
const HOSTILE = [
	"F1$(touch${IFS}/tmp/x)",
	"F1;id",
	"F1`id`",
	"F1|id",
	"1F",
	"F 1",
];

// Scenario ids reach `sh -c` through {ownedGrep}, so an id is a name and nothing more.
describe("scenario ids", () => {
	it.each(["F1", "S01", "T28", "AC-3", "F_2"])("accepts %s", (id) => {
		const p = parseParent(raw(`scope: x\nscenario: ${id} = Given a, Then b`));
		expect(p.scenarios[0]?.id).toBe(id);
	});
	it.each(HOSTILE)("refuses the scenario id %s", (id) => {
		expect(() =>
			parseParent(raw(`scope: x\nscenario: ${id} = Given a, Then b`)),
		).toThrow(BlockError);
	});
	it.each(HOSTILE.filter((id) => !id.includes(" ") && !id.includes(",")))(
		"refuses the requirement and the acceptance id %s",
		(id) => {
			expect(() =>
				parseChild(raw(`wave: 1\nrequirements: ${id}`), [], "."),
			).toThrow(BlockError);
			expect(() =>
				parseChild(raw(`wave: 0\nacceptance: ${id} = specs/a.ts`), [], "."),
			).toThrow(BlockError);
		},
	);
});
