import { describe, expect, it } from "vitest";
import { parseVmStat } from "../../src/env/memory";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                5224.
Pages active:                            879559.
Pages inactive:                          864237.
Pages speculative:                        14004.
Pages throttled:                              0.
Pages wired down:                        390316.
`;

describe("parseVmStat", () => {
	it("counts free, inactive and speculative pages as available", () => {
		expect(Math.round(parseVmStat(VM_STAT))).toBe(
			Math.round(((5224 + 864237 + 14004) * 16384) / 1_048_576),
		);
	});

	it("does not count active or wired pages", () => {
		expect(parseVmStat(VM_STAT)).toBeLessThan(14_000);
	});

	it("throws on output it does not recognise", () => {
		expect(() => parseVmStat("nothing here")).toThrow();
	});
});
