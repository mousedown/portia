import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { closesLines } from "../../src/cli/commands/epic";
import { type Exec, NET_TIMEOUT_MS } from "../../src/core/exec";
import { CLOSES, publishLedger } from "../../src/ledger/publish";
import { END, START } from "../../src/ledger/render";
import type { Tracker } from "../../src/plan/tracker";

it("concurrent publishes take turns, each from its own body file, rendered once its turn comes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-ledger-"));
	writeFileSync(join(dir, "epic.json"), JSON.stringify({ epicPr: 7 }));
	let body = `Human text.\n\n${START}\n${END}`;
	let inside = 0;
	let overlapped = false;
	const files = new Set<string>();
	const exec: Exec = async (_cmd, args) => {
		inside++;
		if (inside > 1) overlapped = true;
		await new Promise((r) => setTimeout(r, 10));
		inside--;
		if (args[1] === "view") return { code: 0, stdout: body, stderr: "" };
		const file = args[args.indexOf("--body-file") + 1] ?? "";
		files.add(file);
		body = readFileSync(file, "utf8");
		return { code: 0, stdout: "", stderr: "" };
	};
	let renders = 0;
	const render = () => `landed: ${++renders}`;
	await Promise.all([
		publishLedger(exec, dir, render),
		publishLedger(exec, dir, render),
	]);
	expect(overlapped).toBe(false);
	expect(files.size).toBe(2);
	expect(body).toContain("Human text.");
	expect(body).toContain("landed: 2");
	expect(body).not.toContain("landed: 1");
	expect(readFileSync(join(dir, "ledger-body.md"), "utf8")).toBe(body);
	expect(readdirSync(dir).sort()).toEqual(["epic.json", "ledger-body.md"]);
});

it("a failed edit still leaves the body it tried, and no temp file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-ledger-"));
	writeFileSync(join(dir, "epic.json"), JSON.stringify({ epicPr: 7 }));
	const exec: Exec = async (_cmd, args) =>
		args[1] === "view"
			? { code: 0, stdout: `Human text.\n\n${START}\n${END}`, stderr: "" }
			: { code: 1, stdout: "", stderr: "HTTP 502" };
	await expect(publishLedger(exec, dir, "landed: 1")).rejects.toThrow();
	expect(readFileSync(join(dir, "ledger-body.md"), "utf8")).toContain(
		"landed: 1",
	);
	expect(readdirSync(dir).sort()).toEqual(["epic.json", "ledger-body.md"]);
});

it("bounds the body edit, so a hung edit cannot hold the ledger lock for good", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-ledger-"));
	writeFileSync(join(dir, "epic.json"), JSON.stringify({ epicPr: 7 }));
	const timeouts: (number | undefined)[] = [];
	const exec: Exec = async (_cmd, args, opts) => {
		if (args[1] === "view")
			return { code: 0, stdout: `${START}\n${END}`, stderr: "" };
		timeouts.push(opts?.timeoutMs);
		return { code: 0, stdout: "", stderr: "" };
	};
	await publishLedger(exec, dir, "landed: 1");
	expect(timeouts).toEqual([NET_TIMEOUT_MS.gh]);
});

it("carries the epic's Closes lines inside the region, so a later publish keeps them", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-ledger-"));
	writeFileSync(join(dir, "epic.json"), JSON.stringify({ epicPr: 7 }));
	writeFileSync(join(dir, CLOSES), "Closes o/r#1\nCloses o/r#2\n");
	let body = `Human text.\n\n${START}\n${END}`;
	const exec: Exec = async (_cmd, args) => {
		if (args[1] === "view") return { code: 0, stdout: body, stderr: "" };
		body = readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8");
		return { code: 0, stdout: "", stderr: "" };
	};
	await publishLedger(exec, dir, "landed: 1");
	await publishLedger(exec, dir, "landed: 2");
	expect(body).toContain("Human text.");
	expect(body).toContain("landed: 2\n\nCloses o/r#1\nCloses o/r#2");
	expect(body.match(/Closes o\/r#1/g)).toHaveLength(1);
	expect(body.indexOf("Closes")).toBeLessThan(body.indexOf(END));
});

it("names each landed issue for a tracker with refs, and nothing for one without", async () => {
	const refs = {
		issueRef: async (k: string) => `o/r#${k.split("-")[1]}`,
	} as unknown as Tracker;
	expect(await closesLines(refs, ["ACME-500", "ACME-501"])).toBe(
		"Closes o/r#500\nCloses o/r#501",
	);
	expect(await closesLines({} as Tracker, ["ACME-500"])).toBe("");
});
