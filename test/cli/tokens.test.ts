import { expect, it } from "vitest";
import { parseTokens } from "../../src/cli/commands/result";

it("requires --tokens to be a non-negative integer", () => {
	expect(parseTokens("0")).toBe(0);
	expect(parseTokens("12345")).toBe(12345);
	for (const bad of [undefined, "", "abc", "-1", "1.5", "Infinity", "NaN"])
		expect(() => parseTokens(bad)).toThrow(/--tokens <n> is required/);
});
