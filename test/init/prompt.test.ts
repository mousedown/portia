import { PassThrough } from "node:stream";
import { isCancel } from "@clack/core";
import { expect, it } from "vitest";
import { suggestText } from "../../src/init/prompt";

/** Answer a prompt with keystrokes over streams, each after the last has been handled. */
async function answer(
	suggestion: string,
	keys: string[],
	validate?: (v: string) => string | undefined,
) {
	const input = new PassThrough();
	const output = new PassThrough();
	let screen = "";
	output.on("data", (d) => {
		screen += String(d);
	});
	const done = suggestText({
		message: "Which?",
		suggestion,
		validate,
		input,
		output,
	});
	for (const k of keys) {
		await new Promise((r) => setTimeout(r, 5));
		input.write(k);
	}
	return { value: await done, screen: () => screen };
}

it("Enter takes the suggestion", async () => {
	expect((await answer("pytest", ["\r"])).value).toBe("pytest");
});
it("Tab fills the suggestion so it can be edited", async () => {
	expect((await answer("pytest", ["\t", " -q", "\r"])).value).toBe("pytest -q");
});
it("Tab completes a prefix of the suggestion", async () => {
	expect((await answer("go test ./...", ["go", "\t", "\r"])).value).toBe(
		"go test ./...",
	);
});
it("Tab leaves alone text that is not a prefix of the suggestion", async () => {
	expect((await answer("pytest", ["make", "\t", "\r"])).value).toBe("make");
});
it("typing replaces the suggestion rather than appending to it", async () => {
	expect((await answer("4", ["8", "\r"])).value).toBe("8");
});
it("says what Tab and Enter do", async () => {
	const { screen } = await answer("pytest", ["\r"]);
	expect(screen()).toContain("Tab to edit");
	expect(screen()).toContain("Enter to accept");
});
it("with no suggestion, Enter on nothing is refused by the validator", async () => {
	const { value, screen } = await answer("", ["\r", "make test", "\r"], (v) =>
		v ? undefined : "Name at least one command",
	);
	expect(value).toBe("make test");
	expect(screen()).toContain("Name at least one command");
	expect(screen()).not.toContain("Tab to edit");
});
it("Ctrl-C cancels", async () => {
	expect(isCancel((await answer("x", ["\x03"])).value)).toBe(true);
});
