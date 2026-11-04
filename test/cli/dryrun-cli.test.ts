import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../../src/cli/main";

const saved = {
	PORTIA_DRY_RUN: process.env.PORTIA_DRY_RUN,
	PORTIA_HOME: process.env.PORTIA_HOME,
	PORTIA_PROFILES_DIR: process.env.PORTIA_PROFILES_DIR,
};
afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

it("--dry-run sets the switch and moves PORTIA_HOME to a fresh temp dir", async () => {
	const err: string[] = [];
	await runCli(["--dry-run", "nonsense"], {
		out: () => {},
		err: (s) => err.push(s),
	});
	expect(process.env.PORTIA_DRY_RUN).toBe("1");
	const home = process.env.PORTIA_HOME ?? "";
	expect(existsSync(home)).toBe(true);
	expect(home).toContain("portia-dry-run-");
	expect(err[0]).toContain(home);
});

it("--dry-run keeps looking for profiles in the real home", async () => {
	process.env.PORTIA_HOME = "/real/home";
	delete process.env.PORTIA_PROFILES_DIR;
	await runCli(["--dry-run", "nonsense"], { out: () => {}, err: () => {} });
	expect(process.env.PORTIA_PROFILES_DIR).toBe(join("/real/home", "profiles"));
});

it("--dry-run copies each run's log, so a dry run sees what the run has started", async () => {
	const real = mkdtempSync(join(tmpdir(), "portia-real-"));
	mkdirSync(join(real, "runs", "ACME-1"), { recursive: true });
	writeFileSync(
		join(real, "runs", "ACME-1", "runlog.jsonl"),
		'{"child":"ACME-2"}\n',
	);
	process.env.PORTIA_HOME = real;
	await runCli(["--dry-run", "nonsense"], { out: () => {}, err: () => {} });
	const home = process.env.PORTIA_HOME ?? "";
	expect(home).not.toBe(real);
	expect(
		readFileSync(join(home, "runs", "ACME-1", "runlog.jsonl"), "utf8"),
	).toBe('{"child":"ACME-2"}\n');
});
