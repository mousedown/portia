import { strictEqual } from "node:assert";
import { assistantState } from "../src/assistant.mjs";

test("F2: the assistant answers", () => {
	strictEqual(assistantState().answersOn, true);
});
