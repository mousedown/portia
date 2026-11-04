import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeFileAtomic } from "../../src/core/atomic";

it("replaces a file whole and leaves no temp file behind", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-atomic-"));
	const file = join(dir, "env-ACME-2.json");
	writeFileSync(file, '{"old":true}');
	writeFileAtomic(file, '{"new":true}');
	expect(readFileSync(file, "utf8")).toBe('{"new":true}');
	expect(readdirSync(dir)).toEqual(["env-ACME-2.json"]);
});

it("a failed write keeps the old file and cleans up its temp file", () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-atomic-"));
	const file = join(dir, "ports.json");
	writeFileSync(file, "[4100]");
	// A directory where the target should be: the rename fails after the write.
	mkdirSync(join(dir, "taken"));
	writeFileSync(join(dir, "taken", "x"), "");
	expect(() => writeFileAtomic(join(dir, "taken"), "[]")).toThrow();
	expect(readFileSync(file, "utf8")).toBe("[4100]");
	expect(readdirSync(dir).sort()).toEqual(["ports.json", "taken"]);
});
