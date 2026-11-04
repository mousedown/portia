import { describe, expect, it } from "vitest";
import { commands, runCli } from "../src/cli/main";
import { EXIT } from "../src/core/exit";

const capture = () => {
	const out: string[] = [],
		err: string[] = [];
	return {
		io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
		out,
		err,
	};
};

describe("runCli", () => {
	it("exits 11 and lists commands for an unknown command", async () => {
		const c = capture();
		expect(await runCli(["nope"], c.io)).toBe(EXIT.PROBLEM);
		expect(c.err.join()).toContain("unknown command: nope");
	});
	it("exits 11 with the message when a command throws a plain Error", async () => {
		commands.boom = async () => {
			throw new Error("kaboom");
		};
		const c = capture();
		try {
			expect(await runCli(["boom"], c.io)).toBe(EXIT.PROBLEM);
		} finally {
			delete commands.boom;
		}
		expect(c.err.join()).toContain("kaboom");
	});
	it("shows the banner and the next steps with no command", async () => {
		const c = capture();
		expect(await runCli([], c.io)).toBe(EXIT.OK);
		expect(c.out.join("\n")).toContain("the quality of mercy is not strained");
		expect(c.out.join("\n")).toContain("portia init");
	});
	it("exits 0 for version", async () => {
		const c = capture();
		expect(await runCli(["version"], c.io)).toBe(EXIT.OK);
		expect(c.out[0]).toMatch(/^portia \d+\.\d+\.\d+$/);
	});
});
