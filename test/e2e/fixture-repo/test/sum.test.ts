import { expect, test } from "bun:test";
import { sum } from "../src/sum";

test("sum adds", () => {
	expect(sum(2, 3)).toBe(5);
});
