import { expect, it } from "vitest";
import { formatReport } from "../../src/cli/commands/gate";

it("warns, with the tail, on a passing UNCERTAIN design step", () => {
	const out = formatReport({
		kind: "exit",
		ok: true,
		steps: [
			{ name: "lint", ok: true, tail: "fine" },
			{
				name: "design",
				ok: true,
				tail: "design UNCERTAIN\nUNCERTAIN pixels: 5.0% of pixels differ",
			},
		],
	});
	expect(out).toBe(
		"pass  lint\nwarn  design\ndesign UNCERTAIN\nUNCERTAIN pixels: 5.0% of pixels differ",
	);
});
it("keeps pass and FAIL formatting", () => {
	expect(
		formatReport({
			kind: "exit",
			ok: false,
			steps: [
				{ name: "design", ok: true, tail: "design PASS" },
				{ name: "x", ok: false, tail: "boom" },
			],
		}),
	).toBe("pass  design\nFAIL  x\nboom");
});
