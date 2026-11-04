import { expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import { describeBlockers, splitOutside } from "../../src/result/ripples";

const profile = {
	...testProfile(),
	ripple: {
		tests: testProfile().ripple.tests,
		generated: ["packages/app/src/generated/**"],
	},
};
const siblings = [{ key: "ACME-3", touches: ["packages/app/test/ledger/**"] }];

it("carries a spec outside the touches as a test ripple", () => {
	expect(
		splitOutside(["packages/app/test/invoices/total.test.ts"], profile, []),
	).toEqual({
		ripples: [
			{ file: "packages/app/test/invoices/total.test.ts", kind: "test" },
		],
		blockers: [],
	});
});

it("carries generated output as a generated ripple", () => {
	expect(
		splitOutside(["packages/app/src/generated/schema.ts"], profile, []),
	).toEqual({
		ripples: [
			{ file: "packages/app/src/generated/schema.ts", kind: "generated" },
		],
		blockers: [],
	});
});

it("blocks on a production file and carries the test ripple beside it", () => {
	expect(
		splitOutside(
			["packages/app/src/ledger/csv.ts", "packages/app/test/a.test.ts"],
			profile,
			[],
		),
	).toEqual({
		ripples: [{ file: "packages/app/test/a.test.ts", kind: "test" }],
		blockers: [{ file: "packages/app/src/ledger/csv.ts" }],
	});
});

it("blocks on a spec under a sensitive glob", () => {
	expect(
		splitOutside(["packages/app/test/payments/charge.test.ts"], profile, []),
	).toEqual({
		ripples: [],
		blockers: [{ file: "packages/app/test/payments/charge.test.ts" }],
	});
});

it("blocks on a spec another child in the wave touches, naming that child", () => {
	const split = splitOutside(
		["packages/app/test/ledger/csv.test.ts"],
		profile,
		siblings,
	);
	expect(split).toEqual({
		ripples: [],
		blockers: [
			{ file: "packages/app/test/ledger/csv.test.ts", sibling: "ACME-3" },
		],
	});
	expect(describeBlockers(split.blockers)).toBe(
		"packages/app/test/ledger/csv.test.ts (in ACME-3's touches)",
	);
});
