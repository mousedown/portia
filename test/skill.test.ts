import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commands } from "../src/cli/main";

const skill = readFileSync(
	join(__dirname, "../skills/portia/SKILL.md"),
	"utf8",
);
const brief = readFileSync(
	join(__dirname, "../skills/portia/worker-brief.md"),
	"utf8",
);

it("names only commands the CLI has", () => {
	const named = new Set(
		[...skill.matchAll(/`portia ([a-z-]+)/g)].map((m) => m[1]),
	);
	expect([...named].filter((n) => !(n! in commands))).toEqual([]);
	expect(named.size).toBeGreaterThan(10);
});
it("branches only on exit codes 0, 10 and 11", () => {
	const codes = new Set(
		[...skill.matchAll(/exit (\d+)/gi)].map((m) => Number(m[1])),
	);
	expect([...codes].filter((c) => ![0, 10, 11].includes(c))).toEqual([]);
});
it("has frontmatter with a name and description", () => {
	expect(skill).toMatch(/^---\nname: portia\ndescription: .+\n---\n/);
});
it("the brief tells the worker the exact result shape", () => {
	expect(brief).toContain('"status":"done|parked|failed"');
});
it("signs off the spine's acceptance tests before the spine lands", () => {
	expect(skill).not.toContain("After wave 0 (the spine) lands");
	const signOff = skill.indexOf("stop for the W5 sign-off");
	expect(signOff).toBeGreaterThan(-1);
	const section = skill.slice(signOff, skill.indexOf("\n", signOff));
	expect(section).toMatch(/before the spine lands/);
	expect(section).toContain("--no --note");
	expect(section).toContain("title starts with its scenario id");
	expect(section).toMatch(/a yes lands the spine/);
});
it("runs the long commands in the background, never in the foreground", () => {
	const line = skill.split("\n").find((l) => l.includes("run_in_background"));
	expect(line).toBeDefined();
	for (const cmd of [
		"`portia land`",
		"`portia epic`",
		"`portia gate wave`",
		"`portia gate baseline`",
		"`portia env template`",
	])
		expect(line).toContain(cmd);
	expect(line).toMatch(/never in the foreground/);
	expect(line).toMatch(/concurrently/);
});
it("plans the epic with the person before intake, and writes nothing without their yes", () => {
	const start = skill.indexOf("## 0. Plan");
	const intake = skill.indexOf("## 1. Intake");
	expect(start).toBeGreaterThan(-1);
	expect(start).toBeLessThan(intake);
	const plan = skill.slice(start, intake);
	for (const s of [
		"`portia plan context <PARENT> --out <file>`",
		"`portia plan write <PARENT> --from <file>`",
		"`parent.block` is null",
		"`run.started`",
		"wave · key · summary · needs · files touched · scenarios",
		"counts as satisfied",
		"excludeLabels",
		"disjoint",
		"failing acceptance spec",
		'"<id>: "',
		"the target repo's acceptance specs",
		"`design: <link> route=<path> persona=<name> frames=<frame>,<frame>`",
		"no larger than the context file's `maxSize`",
		"`acceptance: <id> = <path>`",
		'"was not written"',
		'"partially written"',
		"re-run the same file",
	])
		expect(plan).toContain(s);
	expect(plan).toMatch(/never put a plan block on a done ticket/i);
	expect(plan).toMatch(/wait for an explicit yes/i);
	expect(plan).toMatch(/never run `portia plan write` without/i);
	expect(plan).toMatch(/never re-plan a child/i);
	// The plan-or-skip decision comes from the context file, never from check's wording.
	expect(plan).not.toContain("portia check");
	expect(skill).toContain(
		"Never read meaning into its wording; the only exceptions are the JSON fields and the quoted phrases a step names exactly.",
	);
});
it("shows each child's ripple count in the plan table, and widens touches on a ripple warning", () => {
	const plan = skill.slice(
		skill.indexOf("## 0. Plan"),
		skill.indexOf("## 1. Intake"),
	);
	const table = plan.split("\n").find((l) => l.includes("wave table")) ?? "";
	expect(table).toMatch(
		/ripples column: each child's ripple count from the `ripples` field/,
	);
	expect(table).toContain("--dry-run --json");
	expect(table).toMatch(/`ripple` warning .*widen that child's touches/);
});
it("carries the learnings from a real run", () => {
	const line = (needle: string) =>
		skill.split("\n").find((l) => l.includes(needle)) ?? "";
	expect(line("Shared registry files")).toMatch(/spine scaffolds them/);
	expect(line("Shared registry files")).toMatch(/standing rule/);
	expect(line("`portia integration sync <PARENT>`")).toMatch(
		/typecheck in the integration worktree/,
	);
	expect(line("`portia integration sync <PARENT>`")).toMatch(
		/migration renamed/,
	);
	expect(line("rebase conflict in a shared registry file")).toMatch(
		/git rebase --continue.*answer the park/,
	);
	expect(line("stop for the W5 sign-off")).toMatch(/read-only reviewer agent/);
});
it("waits on a long command only through its notification", () => {
	const line =
		skill.split("\n").find((l) => l.startsWith("**Long commands:**")) ?? "";
	expect(line).toMatch(/never chained after another command with `&&`/);
	expect(line).toMatch(/never poll for one with `pgrep`/);
});
it("approves extra files per child with portia touches, never the profile", () => {
	const line = skill
		.split("\n")
		.find((l) => l.includes("portia touches allow"));
	expect(line).toMatch(/--why/);
	expect(line).toMatch(/Never widen the profile's `allowedIncidental`/);
});

it("the setup skill names only commands the CLI has", () => {
	const setup = readFileSync(
		join(__dirname, "../skills/portia-setup/SKILL.md"),
		"utf8",
	);
	expect(setup).toMatch(/^---\nname: portia-setup\ndescription: .+\n---\n/);
	const named = [...setup.matchAll(/`portia ([a-z-]+)/g)].map(
		(m) => m[1] ?? "",
	);
	expect(named.filter((n) => !(n in commands))).toEqual([]);
	expect(named).toContain("init");
});
it("drives the run with portia drive, in the background, and starts no subagent", () => {
	const drive = skill.slice(skill.indexOf("## 3. Drive"));
	expect(skill).not.toMatch(/background subagent/);
	expect(skill).toContain("start a worker as a subagent");
	expect(drive).toMatch(
		/`portia drive <PARENT> --json`, run with `run_in_background`/,
	);
	expect(drive).toMatch(
		/Exit 0 is epic-ready. Exit 10 .* Exit 11 is failed or error/,
	);
	for (const kind of [
		"plan",
		"questions",
		"spec-signoff",
		"parked",
		"failed",
		"error",
		"epic-ready",
	])
		expect(drive).toContain(`\`${kind}\``);
	expect(drive).toContain(
		"`portia drive <PARENT> --answer <KEY> --note-file <file>`",
	);
	const long = skill.split("\n").find((l) => l.includes("run_in_background"));
	expect(long).toContain("`portia drive`");
	expect(long).toContain("`portia worker wait`");
	expect(skill).toContain('`workers.mode: "detached"`');
});
it("asks the scripted person before the person, at every question", () => {
	const at = skill.indexOf("**Scripted person.**");
	expect(at).toBeGreaterThan(-1);
	const section = skill.slice(at, skill.indexOf("## 0. Plan"));
	for (const s of [
		"`portia eval-answer plan <PARENT> --from <file>`",
		"`portia eval-answer go <PARENT>`",
		"`portia eval-answer questions <PARENT>`",
		"`portia eval-answer specs <PARENT>`",
		'`portia eval-answer parked <KEY> --parent <PARENT> --question "<the question>"`',
		"Exit 10: there is no scripted answer, so ask the person",
	])
		expect(section).toContain(s);
});
it("turns a spec that needs another scenario's feature into a need or a decoupled spec before the sign-off", () => {
	const line =
		skill.split("\n").find((l) => l.includes("stop for the W5 sign-off")) ?? "";
	const review = line.slice(0, line.indexOf("Then stop for the W5 sign-off"));
	expect(line).toContain("`spec-signoff`");
	expect(review).toContain("`portia plan specs <PARENT> --json`");
	expect(review).toMatch(
		/no spec depending on behaviour another scenario delivers/,
	);
	expect(review).toMatch(/name both scenarios/);
	expect(review).toMatch(/decouple the spec/);
	expect(review).toMatch(
		/`portia plan write <PARENT> --from <file>` with the parent block unchanged and that child alone/,
	);
	expect(review).toMatch(/refuses a child already started/);
});
