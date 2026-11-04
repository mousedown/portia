import { deepStrictEqual } from "node:assert";
import { assistantState } from "../src/assistant.mjs";
import { hide } from "../src/hide.mjs";

test("F1: hiding the assistant closes it", () => {
	deepStrictEqual(hide(assistantState()), { open: false });
});
