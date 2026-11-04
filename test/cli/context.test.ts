import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.stubEnv(
		"PORTIA_PROFILE",
		join(import.meta.dirname, "../fixtures/profile.ts"),
	);
});

describe("loadForCli", () => {
	it("does not create the run directory until dir is read", async () => {
		const home = mkdtempSync(join(tmpdir(), "portia-ctx-"));
		vi.stubEnv("HOME", home);
		vi.doMock("../../src/plan/load", () => ({
			loadPlan: async () => ({ plan: { key: "ACME-1" }, findings: [] }),
		}));
		vi.doMock("../../src/plan/repo", () => ({
			repoFiles: async () => [],
			topLevelOf: () => new Set(),
		}));
		vi.doMock("../../src/plan/tracker", () => ({
			trackerFromProfile: () => ({}),
		}));
		const { loadForCli } = await import("../../src/cli/context");
		const ctx = await loadForCli("acme-1");
		const dir = join(home, ".portia", "runs", "ACME-1");
		expect(existsSync(dir)).toBe(false);
		expect(ctx.dir).toContain("ACME-1");
		expect(existsSync(ctx.dir)).toBe(true);
	});
});

describe("loadForCli findings", () => {
	const mockPlan = () => {
		vi.resetModules();
		vi.doMock("../../src/plan/load", () => ({
			loadPlan: async () => ({
				plan: { key: "ACME-1" },
				findings: [
					{
						rule: "parse",
						level: "error",
						child: "ACME-2",
						message: "bad block",
					},
				],
			}),
		}));
		vi.doMock("../../src/plan/repo", () => ({
			repoFiles: async () => [],
			topLevelOf: () => new Set(),
		}));
		vi.doMock("../../src/plan/tracker", () => ({
			trackerFromProfile: () => ({}),
		}));
	};
	it("throws a PortiaProblem listing the error findings", async () => {
		mockPlan();
		const { loadForCli } = await import("../../src/cli/context");
		const { PortiaProblem } = await import("../../src/core/exit");
		const err = await loadForCli("acme-1").catch((e) => e);
		expect(err).toBeInstanceOf(PortiaProblem);
		expect(err.message).toContain("parse ACME-2: bad block");
	});
	it("returns the findings when the caller opts in", async () => {
		mockPlan();
		const { loadForCli } = await import("../../src/cli/context");
		const ctx = await loadForCli("acme-1", { allowFindings: true });
		expect(ctx.findings).toHaveLength(1);
	});
});

describe("cliContext tracker", () => {
	it("builds the tracker only when it is read", async () => {
		vi.resetModules();
		const built = vi.fn(() => ({}));
		vi.doMock("../../src/plan/tracker", () => ({ trackerFromProfile: built }));
		const { cliContext } = await import("../../src/cli/context");
		const ctx = await cliContext();
		expect(built).not.toHaveBeenCalled();
		expect(ctx.tracker).toBe(ctx.tracker);
		expect(built).toHaveBeenCalledTimes(1);
	});
});

describe("cliContext repository", () => {
	it("asks git where the repository is once per directory", async () => {
		vi.resetModules();
		vi.doUnmock("../../src/plan/tracker");
		const { cliContext } = await import("../../src/cli/context");
		const { spawnExec, useSpawner } = await import("../../src/core/exec");
		const asked: string[] = [];
		const restore = useSpawner((cmd, args, opts) => {
			if (cmd === "git" && args[0] === "rev-parse") asked.push(args.join(" "));
			return spawnExec(cmd, args, opts);
		});
		try {
			const a = await cliContext();
			const b = await cliContext();
			expect(b.repoRoot).toBe(a.repoRoot);
			expect(asked).toHaveLength(2);
		} finally {
			restore();
		}
	});
});
