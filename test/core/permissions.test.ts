import { expect, it } from "vitest";
import { mergeDenies } from "../../src/core/permissions";

it("adds deny rules, keeps every existing rule, and never adds an allow (H5, H9)", () => {
	const before = {
		permissions: { allow: ["Bash(bun run test)"], deny: ["Read(.env)"] },
		model: "x",
	};
	const after = mergeDenies(before, [
		"Read(.env)",
		"Bash(git push origin main)",
	]);
	expect(after).toEqual({
		permissions: {
			allow: ["Bash(bun run test)"],
			deny: ["Read(.env)", "Bash(git push origin main)"],
		},
		model: "x",
	});
});
