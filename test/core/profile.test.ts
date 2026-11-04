import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import example from "../../examples/profile.example";
import { permissionsCommand } from "../../src/cli/commands/permissions";
import { ProfileSchema, testProfile } from "../../src/core/config";
import acme from "../fixtures/profile";

vi.mock("../../src/cli/context", async (orig) => {
	const mod = await orig<typeof import("../../src/cli/context")>();
	const { default: acme } = await import("../fixtures/profile");
	return {
		...mod,
		cliContext: async () => ({
			repoRoot: "/unused",
			profile: ProfileSchema.parse(acme),
		}),
	};
});

it("the fixture profile parses and only adds deny rules", () => {
	const p = ProfileSchema.parse(acme);
	expect(p.denyRules).toEqual([
		"Bash(gh pr merge*)",
		"Bash(git push*main*)",
		"Bash(git push*--force*)",
	]);
	expect(p.gates.task.length).toBeGreaterThan(0);
});

it("excludeLabels comes from the profile; nothing by default", () => {
	expect(ProfileSchema.parse(acme).excludeLabels).toEqual(["launch-readiness"]);
	expect(testProfile().excludeLabels).toEqual([]);
});

it("the permissions command says the deny rules persist in settings.local.json", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "portia-perm-"));
	vi.spyOn(process, "cwd").mockReturnValue(cwd);
	const out: string[] = [];
	try {
		await permissionsCommand([], { out: (s) => out.push(s), err: () => {} });
	} finally {
		vi.restoreAllMocks();
	}
	expect(out.join("\n")).toContain(".claude/settings.local.json");
	expect(out.join("\n")).toContain("persist");
	expect(
		JSON.parse(
			readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8"),
		).permissions.deny,
	).toContain("Bash(gh pr merge*)");
});

it("starts with no design personas", () => {
	const p = ProfileSchema.parse(acme);
	expect(p.design.personas).toEqual({});
});

it.each([
	"E2E_PARENT_EMAIL",
	"onboarding/personas",
	"onboarding/personas#",
	"#newMember",
	"../x#a",
	"/abs/x#a",
	"onboarding/personas#1bad",
])("rejects the persona target %s", (target) => {
	const raw = acme;
	const bad = { ...raw, design: { ...raw.design, personas: { p: target } } };
	expect(ProfileSchema.safeParse(bad).success).toBe(false);
});

it("ends the exit gate with the child's own acceptance scenarios", () => {
	const p = ProfileSchema.parse(acme);
	expect(p.gates.exit.at(-1)).toEqual({
		name: "acceptance",
		cmd: 'env -u DATABASE_URL_UNPOOLED bunx vitest run {owned} --maxWorkers=4 -t "(^| )({ownedGrep}): "',
		heavy: true,
		cwd: "package",
	});
});

it("the acceptance grep selects an owned id's title and not a longer id", () => {
	const step = ProfileSchema.parse(acme).gates.exit.at(-1);
	const grep = step?.cmd.match(/-t "(.*)"$/)?.[1];
	if (!grep) throw new Error("no -g pattern");
	// Playwright builds a case-insensitive RegExp and matches the space-joined title path.
	const re = new RegExp(grep.replace("{ownedGrep}", "F1|F3"), "i");
	expect(re.test("onboarding/checklist.e2e.ts F1: cold start")).toBe(true);
	expect(re.test("chromium onboarding/checklist.e2e.ts F3: x")).toBe(true);
	expect(re.test("onboarding/checklist.e2e.ts F10: ten")).toBe(false);
	expect(re.test("onboarding/checklist.e2e.ts XF1: other")).toBe(false);
	expect(re.test("onboarding/checklist.e2e.ts mentions F1 in passing")).toBe(
		false,
	);
});

it("a profile's gateEnv carries env for the gates; the default is none", () => {
	const p = ProfileSchema.parse(acme);
	expect(p.gateEnv).toEqual({ PAYMENTS_PUBLIC_KEY: "pk_test_placeholder" });
	const steps = [...p.gates.task, ...p.gates.exit, ...p.gates.epic];
	for (const s of steps) expect(s.cmd).not.toContain("PAYMENTS_PUBLIC_KEY");
	expect(testProfile().gateEnv).toEqual({});
});

describe("examples/profile.example.ts", () => {
	const raw = example as Record<string, unknown>;
	const p = ProfileSchema.parse(example);

	it("parses, and sets every option rather than leaning on defaults", () => {
		for (const k of Object.keys(ProfileSchema.in.shape))
			if (k !== "ratchet") expect(raw, k).toHaveProperty(k);
	});

	it("shows conditional and retried gate steps, services, debt rules and personas", () => {
		const steps = [...p.gates.task, ...p.gates.exit, ...p.gates.epic];
		expect(steps.some((s) => s.whenTouches?.length)).toBe(true);
		expect(steps.some((s) => (s.retries ?? 0) > 0)).toBe(true);
		expect(Object.keys(p.gateEnv).length).toBeGreaterThan(0);
		expect(p.briefNotes.length).toBeGreaterThan(0);
		expect(p.services.length).toBeGreaterThan(0);
		expect(p.debt.length).toBeGreaterThan(0);
		expect(Object.keys(p.design.personas).length).toBeGreaterThan(0);
		expect(p.db).toBeDefined();
	});

	it("is for a fictional repository", () => {
		expect(p.repo).toBe("acme-web");
	});
});

it("reviews no child by default; a review.child gets its timeout and onFindings defaults", () => {
	expect(testProfile().review).toBeUndefined();
	expect(ProfileSchema.parse(acme).review).toBeUndefined();
	const p = ProfileSchema.parse({
		...acme,
		review: { child: { cmd: 'reviewer --diff "$PORTIA_DIFF"' } },
	});
	expect(p.review?.child).toEqual({
		cmd: 'reviewer --diff "$PORTIA_DIFF"',
		timeoutMs: 20 * 60_000,
		onFindings: "fail",
	});
	for (const child of [
		{ cmd: "" },
		{ cmd: "x", timeoutMs: 0 },
		{ cmd: "x", onFindings: "ignore" },
		{ cmd: "x", timeoutMs: 2 ** 31 },
		{ command: "x" },
		{ cmd: "x", timout: 5 },
	])
		expect(
			ProfileSchema.safeParse({ ...acme, review: { child } }).success,
		).toBe(false);
	for (const review of [{}, { chlid: { cmd: "x" } }])
		expect(ProfileSchema.safeParse({ ...acme, review }).success).toBe(false);
});

it("a waveGate names only gates.epic steps; it is off by default", () => {
	const base = {
		...testProfile(),
		gates: {
			task: [],
			exit: [],
			epic: [{ name: "unit", cmd: "bun test", heavy: true, cwd: "root" }],
		},
	};
	expect(testProfile().waveGate).toBeUndefined();
	expect(
		ProfileSchema.parse({ ...base, waveGate: { steps: ["unit"] } }).waveGate,
	).toEqual({ steps: ["unit"] });
	const bad = ProfileSchema.safeParse({
		...base,
		waveGate: { steps: ["unit", "integration"] },
	});
	expect(bad.success).toBe(false);
	expect(bad.error?.issues).toEqual([
		expect.objectContaining({
			path: ["waveGate", "steps", 1],
			message: "'integration' is not a gates.epic step (unit)",
		}),
	]);
	expect(
		ProfileSchema.safeParse({ ...base, waveGate: { steps: [] } }).success,
	).toBe(false);
});
