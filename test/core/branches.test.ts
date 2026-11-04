import { expect, it } from "vitest";
import {
	childBranch,
	childKeyOf,
	integrationBranch,
} from "../../src/core/branches";
import { ProfileSchema, testProfile } from "../../src/core/config";

it("derives every branch from the profile's branchPrefix", () => {
	const p = { ...testProfile(), branchPrefix: "epic" };
	expect(integrationBranch(p, "ACME-1")).toBe("epic/ACME-1");
	expect(childBranch(p, "ACME-2")).toBe("epic/ACME-2");
	expect(childKeyOf(p, "epic/ACME-2")).toBe("ACME-2");
	expect(childKeyOf(p, "portia/ACME-2")).toBeUndefined();
});

it("defaults the prefix to portia and rejects unsafe prefixes", () => {
	expect(testProfile().branchPrefix).toBe("portia");
	const base = testProfile();
	for (const bad of ["", "Epic", "a/b", "1x", "x_y", "main", "master"])
		expect(
			ProfileSchema.safeParse({ ...base, branchPrefix: bad }).success,
			bad,
		).toBe(false);
});
