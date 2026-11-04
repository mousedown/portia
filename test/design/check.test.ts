import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { testProfile } from "../../src/core/config";
import type { ChildPlan } from "../../src/core/types";
import { designCheck } from "../../src/design/check";
import { writeFrame } from "../../src/design/store";
import { fakeExec } from "../helpers/fake-exec";

it("refuses an unmapped persona without running playwright", async () => {
	const dir = mkdtempSync(join(tmpdir(), "portia-check-"));
	const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
	writeFrame(
		dir,
		"ACME-2",
		{ name: "f1", width: 4, height: 4, source: "canvas" },
		png,
		[],
	);
	const { exec, calls } = fakeExec();
	const child = {
		key: "ACME-2",
		design: "https://x route=/discover persona=ghost frames=f1",
	} as ChildPlan;
	const r = await designCheck(child, {
		exec,
		profile: testProfile(),
		dir,
		env: {
			worktree: dir,
			branch: "portia/ACME-2",
			db: "",
			port: 0,
			envFile: join(dir, ".env"),
		},
	});
	expect(r).toEqual({
		ok: false,
		tail: "design check did not run (never a PASS): persona 'ghost' is not mapped in profile.design.personas",
	});
	expect(calls.some((c) => c.args.includes("playwright"))).toBe(false);
});

const setup = (key: string) => {
	const dir = mkdtempSync(join(tmpdir(), "portia-check-"));
	const worktree = mkdtempSync(join(tmpdir(), "portia-wt-"));
	const png = PNG.sync.write(new PNG({ width: 4, height: 4 }));
	writeFrame(
		dir,
		key,
		{ name: "f1", width: 4, height: 4, source: "canvas" },
		png,
		[],
	);
	const base = testProfile();
	const profile = {
		...base,
		design: {
			...base.design,
			personas: { parent: "onboarding/personas#newMember" },
		},
	};
	const child = {
		key,
		design: "https://x route=/discover persona=parent frames=f1",
	} as ChildPlan;
	const ctx = {
		profile,
		dir,
		env: {
			worktree,
			branch: `portia/${key}`,
			db: "",
			port: 0,
			envFile: join(dir, ".env"),
		},
	};
	const specDir = join(worktree, profile.packageDir, "e2e", "portia-design");
	return {
		dir,
		png,
		child,
		ctx,
		specDir,
		specFile: join(specDir, `design-${key}.e2e.ts`),
	};
};

it("removes the generated spec after a passing playwright run", async () => {
	const s = setup("ACME-3");
	let seen = false;
	const { exec } = fakeExec((c) => {
		if (c.cmd === "git") return { stdout: "info-exclude\n" };
		seen = existsSync(s.specFile);
		const out = join(s.dir, "design", "ACME-3");
		writeFileSync(join(out, "actual-f1.json"), JSON.stringify({ values: [] }));
		writeFileSync(join(out, "actual-f1.png"), s.png);
		return undefined;
	});
	await designCheck(s.child, { exec, ...s.ctx });
	expect(seen).toBe(true);
	expect(existsSync(s.specFile)).toBe(false);
	expect(existsSync(s.specDir)).toBe(false);
});

it("removes the generated spec after a failing playwright run", async () => {
	const s = setup("ACME-4");
	const { exec } = fakeExec((c) =>
		c.cmd === "git"
			? { stdout: "info-exclude\n" }
			: { code: 1, stderr: "boom" },
	);
	const r = await designCheck(s.child, { exec, ...s.ctx });
	expect(r.ok).toBe(false);
	expect(existsSync(s.specFile)).toBe(false);
	expect(existsSync(s.specDir)).toBe(false);
});

it("refuses a malformed persona target without running playwright", async () => {
	const s = setup("ACME-5");
	s.ctx.profile = {
		...s.ctx.profile,
		design: { ...s.ctx.profile.design, personas: { parent: "SOME_EMAIL" } },
	};
	const { exec, calls } = fakeExec();
	const r = await designCheck(s.child, { exec, ...s.ctx });
	expect(r.ok).toBe(false);
	expect(r.tail).toContain("design check did not run (never a PASS)");
	expect(r.tail).toContain("<module relative to e2e>#<exportName>");
	expect(calls.some((c) => c.args.includes("playwright"))).toBe(false);
});
