import { expect, it } from "vitest";
import { newTypeErrors, parseTsc } from "../../src/gate/typecheck";

const base = "src/a.ts(1,1): error TS2322: x\nsrc/b.ts(2,2): error TS2345: y\n";
const now =
	"src/a.ts(1,1): error TS2322: x\nsrc/a.ts(9,9): error TS2339: z\nsrc/b.ts(2,2): error TS2345: y\nsrc/c.ts(3,3): error TS1: w\n";

it("counts errors per file", () => {
	expect(parseTsc(base)).toEqual(
		new Map([
			["src/a.ts", 1],
			["src/b.ts", 1],
		]),
	);
});
it("reports only new errors in touched files", () => {
	expect(
		newTypeErrors(parseTsc(base), parseTsc(now), ["src/a.ts", "src/b.ts"]),
	).toEqual(["src/a.ts: 1 new error(s)"]);
});
