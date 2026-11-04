import { strictEqual } from "node:assert";
import { answersOn } from "../src/answers.mjs";

test("F2: the assistant answers", () => {
	strictEqual(answersOn(), true);
});
