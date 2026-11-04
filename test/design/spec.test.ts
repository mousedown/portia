import { expect, it } from "vitest";
import { generateSpec } from "../../src/design/spec";

it("runs the persona helper, visits the route per frame and writes the actual values", () => {
	const s = generateSpec({
		key: "ACME-2",
		route: "/discover",
		personaModule: "onboarding/personas",
		personaExport: "newMember",
		outDir: "/runs/ACME-0/design/ACME-2",
		frames: [
			{ name: "cold-start-1440", width: 1440, height: 900, source: "canvas" },
		],
	});
	expect(s).toContain(
		'import { newMember as persona } from "../onboarding/personas"',
	);
	expect(s).toContain("await persona(page)");
	expect(s).not.toContain("signInThrottled");
	expect(s).not.toContain("process.env");
	expect(s).toContain('page.goto("/discover")');
	expect(s).toContain("document.fonts.ready");
	expect(s).toContain('"/runs/ACME-0/design/ACME-2"');
});
