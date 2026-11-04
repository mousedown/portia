import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runPath } from "../../src/core/rundir";
import { appendRow } from "../../src/core/runlog";
import type { DriveResult, StepName } from "../../src/drive/types";
import {
	CHILDREN,
	type DriveRun,
	driveRun,
	landedOrder,
	PARENT,
	SPINE,
	WAVE1,
} from "./drive-support";

const LONG = 180_000;
const QUESTION = "Which greeting should it use?";
const [A, B] = WAVE1;

let run: DriveRun | undefined;
afterEach(async () => {
	await run?.done();
	run = undefined;
});

const sorted = (xs: readonly string[]) => [...xs].sort();
const stepsOf = (r: DriveResult | undefined, step: StepName) =>
	(r?.steps ?? []).filter((s) => s.step === step).map((s) => s.child);
const merged = (r: DriveRun, child: string) =>
	r.prs.filter((p) => p.head.endsWith(`/${child}`) && p.state === "merged")
		.length;

/** The first drive of a planned run: the spine's worker runs, and its specs wait for the sign-off. */
async function toSignoff(r: DriveRun) {
	const d = await r.drive();
	expect(d.result?.stop, d.err).toMatchObject({
		kind: "spec-signoff",
		spine: SPINE,
	});
	return d;
}

async function signSpecs(r: DriveRun) {
	const s = await r.portia("signoff", "specs", PARENT);
	expect(s.code, s.err).toBe(0);
}

it(
	"D1: Given a planned run whose workers are detached and whose children all pass their gates, Then the drive command lands every child in dependency order and stops with epic-ready, with no orchestrator turn between steps",
	async () => {
		run = await driveRun();
		await run.approvePlan();
		await toSignoff(run);
		await signSpecs(run);

		const d = await run.drive();
		expect(d.code, d.err).toBe(0);
		expect(d.result?.stop).toMatchObject({ kind: "epic-ready" });
		if (d.result?.stop.kind !== "epic-ready") return;
		expect(sorted(d.result.stop.landed)).toEqual(sorted(CHILDREN));

		// One drive took every step after the sign-off: the spine's land, then each wave 1
		// child from dispatch to land, then the epic gate.
		for (const k of WAVE1) expect(stepsOf(d.result, "dispatch")).toContain(k);
		expect(sorted(stepsOf(d.result, "land"))).toEqual(sorted(CHILDREN));
		expect(stepsOf(d.result, "epic-gate")).toEqual([PARENT]);

		// Dependency order: the spine before either wave 1 child, each landed once.
		const order = landedOrder(run.rows());
		expect(order[0]).toBe(SPINE);
		expect(sorted(order)).toEqual(sorted(CHILDREN));
		for (const k of CHILDREN) expect(merged(run, k)).toBe(1);
	},
	LONG,
);

it(
	"D2: Given a run whose spine worker has finished, Then the drive command stops with spec-signoff and lands nothing until the specs sign-off is recorded",
	async () => {
		run = await driveRun();
		await run.approvePlan();
		const first = await toSignoff(run);
		expect(first.code).toBe(10);
		const result = run
			.rows()
			.find((r) => r.child === SPINE && r.stage === "result");
		expect(result?.status).toBe("done");
		expect(first.result?.stop).toMatchObject({
			attempt: 1,
			head: result?.data?.head,
			specs: { F1: "test/spine.test.ts" },
		});
		expect(landedOrder(run.rows())).toEqual([]);

		// Driving again changes nothing: no land, and no second worker for the spine.
		const again = await toSignoff(run);
		expect(stepsOf(again.result, "land")).toEqual([]);
		expect(landedOrder(run.rows())).toEqual([]);
		expect(merged(run, SPINE)).toBe(0);
		expect(run.count(SPINE, "dispatched")).toBe(1);
		for (const k of WAVE1) expect(run.count(k, "dispatched")).toBe(0);

		await signSpecs(run);
		const after = await run.drive();
		expect(after.result?.stop.kind, after.err).toBe("epic-ready");
		expect(landedOrder(run.rows())[0]).toBe(SPINE);
	},
	LONG,
);

it(
	"D3: Given a child that parks, Then the drive command stops with parked naming the child and its question, and after the answer is recorded a second drive carries on from there",
	async () => {
		run = await driveRun({ park: [A] });
		await run.approvePlan();
		await toSignoff(run);
		await signSpecs(run);

		const parked = await run.drive();
		expect(parked.code, parked.err).toBe(10);
		expect(parked.result?.stop).toMatchObject({
			kind: "parked",
			child: A,
			attempt: 1,
			question: QUESTION,
		});
		expect(landedOrder(run.rows())).not.toContain(A);

		const note = join(run.root, "answer.txt");
		writeFileSync(note, "Say hello.\n");
		const d = await run.drive("--answer", A, "--note-file", note);
		expect(d.code, d.err).toBe(0);
		expect(d.result?.stop.kind).toBe("epic-ready");

		const answer = run
			.rows()
			.find(
				(r) =>
					r.child === A && r.stage === "decision" && r.data?.kind === "parked",
			);
		expect(answer?.data).toMatchObject({
			kind: "parked",
			by: "person",
			answer: "Say hello.",
		});
		// It carried on from the park: the parked child's next worker got the answer,
		// and nothing that had already run ran again.
		expect(run.count(A, "dispatched")).toBe(2);
		expect(
			readFileSync(join(runPath(PARENT), `brief-${A}-2.md`), "utf8"),
		).toContain("Say hello.");
		expect(run.count(SPINE, "dispatched")).toBe(1);
		expect(run.count(B, "dispatched")).toBe(1);
		for (const k of CHILDREN) expect(run.count(k, "landed")).toBe(1);
	},
	LONG,
);

it(
	"D4: Given a scripted answers file with answers for the plan, the specs and a park, Then the drive command applies them itself and stops only where no scripted answer exists",
	async () => {
		run = await driveRun({ park: [A] });
		const parkedAnswers = {
			default: "Use the default.",
			byPattern: [{ match: "greeting", answer: "Say hello." }],
		};
		// No sign-off answer yet: drive approves the plan from the script, runs the spine,
		// and stops at the one question the script cannot answer.
		run.answers({ plan: { approve: true }, parked: parkedAnswers });
		const first = await run.drive();
		expect(first.result?.stop, first.err).toMatchObject({
			kind: "spec-signoff",
			spine: SPINE,
		});
		const approval = run
			.rows()
			.find((r) => r.child === PARENT && r.stage === "approval");
		expect(approval).toMatchObject({
			status: "approved",
			data: { by: "eval" },
		});

		run.answers({
			plan: { approve: true },
			signoff: { approve: true },
			parked: parkedAnswers,
		});
		const d = await run.drive();
		expect(d.code, d.err).toBe(0);
		expect(d.result?.stop.kind).toBe("epic-ready");
		const rows = run.rows();
		expect(
			rows.find((r) => r.child === SPINE && r.stage === "signoff"),
		).toMatchObject({ status: "approved", data: { by: "eval" } });
		expect(
			rows.find(
				(r) =>
					r.child === A && r.stage === "decision" && r.data?.kind === "parked",
			)?.data,
		).toMatchObject({ kind: "parked", by: "eval", answer: "Say hello." });
		expect(run.count(A, "dispatched")).toBe(2);
		expect(
			readFileSync(join(runPath(PARENT), `brief-${A}-2.md`), "utf8"),
		).toContain("Say hello.");
		expect(sorted(landedOrder(rows))).toEqual(sorted(CHILDREN));
	},
	LONG,
);

it(
	"D5: Given a drive interrupted after a child landed, Then a second drive continues without dispatching or landing that child again",
	async () => {
		run = await driveRun();
		await run.approvePlan();
		await toSignoff(run);
		await signSpecs(run);

		// The process dies right after A's PR merges, before the run log records it.
		run.killAfterMerge(A);
		const killed = await run.drive();
		expect(killed.result?.stop.kind).not.toBe("epic-ready");
		expect(merged(run, A)).toBe(1);
		const dispatched = {
			spine: run.count(SPINE, "dispatched"),
			a: run.count(A, "dispatched"),
		};

		const d = await run.drive();
		expect(d.code, d.err).toBe(0);
		expect(d.result?.stop.kind).toBe("epic-ready");
		for (const k of [SPINE, A]) {
			expect(stepsOf(d.result, "dispatch")).not.toContain(k);
			expect(stepsOf(d.result, "land")).not.toContain(k);
		}
		expect(run.count(SPINE, "dispatched")).toBe(dispatched.spine);
		expect(run.count(A, "dispatched")).toBe(dispatched.a);
		for (const k of CHILDREN) {
			expect(merged(run, k)).toBe(1);
			expect(run.count(k, "landed")).toBe(1);
		}
	},
	LONG,
);

it(
	"D6: Given a profile whose workers run as subagents, Then the drive command refuses and names the setting to change",
	async () => {
		run = await driveRun({ workers: "subagent" });
		await run.approvePlan();

		const d = await run.drive();
		expect(d.code).toBe(11);
		expect(d.result?.stop).toMatchObject({ kind: "error" });
		const message =
			d.result?.stop.kind === "error" ? d.result.stop.message : "";
		expect(message).toContain('workers.mode: "detached"');
		expect(message).toContain('"subagent"');

		const plain = await run.portia("drive", PARENT);
		expect(plain.code).toBe(11);
		expect(plain.err).toContain('workers.mode: "detached"');

		// It refused before doing anything.
		expect(d.result?.steps).toEqual([]);
		for (const k of CHILDREN) expect(run.count(k, "dispatched")).toBe(0);
	},
	LONG,
);

it(
	"D7: Given a child whose park was answered and then put to the person, Then the drive command takes the person's answer and carries on with it",
	async () => {
		run = await driveRun({ park: [A] });
		await run.approvePlan();
		await toSignoff(run);
		await signSpecs(run);
		const parked = await run.drive();
		expect(parked.result?.stop, parked.err).toMatchObject({
			kind: "parked",
			child: A,
		});

		// As in a run whose spine parked: an answer that did not help, then the park put to the person.
		const dir = runPath(PARENT);
		appendRow(dir, {
			child: A,
			attempt: 1,
			stage: "decision",
			status: "answer",
			data: { kind: "parked", by: "eval", answer: "Carry on.", why: QUESTION },
		});
		appendRow(dir, {
			child: A,
			attempt: 0,
			stage: "decision",
			status: "ask-human",
			data: {
				kind: "park-answerable",
				by: "rule",
				answer: "ask-human",
				why: "the child touches sensitive code",
			},
		});

		const note = join(run.root, "answer.txt");
		writeFileSync(note, "Say hello.\n");
		const d = await run.drive("--answer", A, "--note-file", note);
		expect(d.code, d.err).toBe(0);
		expect(d.result?.stop.kind).toBe("epic-ready");
		const answers = run
			.rows()
			.filter(
				(r) =>
					r.child === A && r.stage === "decision" && r.data?.kind === "parked",
			);
		expect(answers.at(-1)?.data).toMatchObject({
			by: "person",
			answer: "Say hello.",
			why: QUESTION,
		});
		expect(run.count(A, "dispatched")).toBe(2);
		expect(readFileSync(join(dir, `brief-${A}-2.md`), "utf8")).toContain(
			"Say hello.",
		);
	},
	LONG,
);

it(
	"D8: Given a child whose spend has reached its worker cap, Then the drive command stops with failed at dispatch naming the child, the cap and the spend",
	async () => {
		// The fixture's worker cap is 2,000,000; A's one parked attempt spends all of it.
		run = await driveRun({ park: [A], tokens: { [A]: 2_000_000 } });
		await run.approvePlan();
		await toSignoff(run);
		await signSpecs(run);
		const parked = await run.drive();
		expect(parked.result?.stop, parked.err).toMatchObject({
			kind: "parked",
			child: A,
		});

		const note = join(run.root, "answer.txt");
		writeFileSync(note, "Say hello.\n");
		const d = await run.drive("--answer", A, "--note-file", note);
		expect(d.code, d.err).toBe(11);
		expect(d.result?.stop).toMatchObject({
			kind: "failed",
			child: A,
			step: "dispatch",
			spend: { scope: "worker", spent: 2_000_000, cap: 2_000_000 },
		});
		const reason = d.result?.stop.kind === "failed" ? d.result.stop.reason : "";
		expect(reason).toContain(
			`${A} spend 2000000 reached the worker cap 2000000`,
		);
		expect(reason).toContain("spend.worker");
		// It stopped before dispatching: the answer waits for the cap to be raised.
		expect(run.count(A, "dispatched")).toBe(1);
	},
	LONG,
);

it(
	"D9: Given a scripted sign-off and a spine spec that requests a route another child delivers, which the scenario's owner does not need, Then the drive command stops with spec-signoff naming the coupling, signs nothing off and lands nothing",
	async () => {
		run = await driveRun({ specRoute: "/b/price" });
		const b = await run.tracker.issue(B);
		b.description = `Child B adds POST /b/price.\n\n${b.description}`;
		run.answers({ plan: { approve: true }, signoff: { approve: true } });

		const d = await run.drive();
		expect(d.code, d.err).toBe(10);
		expect(d.result?.stop).toMatchObject({
			kind: "spec-signoff",
			spine: SPINE,
			coupling: [
				{
					scenario: "F1",
					spec: "test/spine.test.ts",
					owner: A,
					other: B,
					via: "route",
					target: "/b/price",
				},
			],
		});
		const signoffs = () =>
			run?.rows().filter((r) => r.child === SPINE && r.stage === "signoff") ??
			[];
		expect(signoffs()).toEqual([]);
		expect(stepsOf(d.result, "signoff")).toEqual([PARENT]);

		// Driving again asks the script nothing until the coupling is settled.
		const again = await run.drive();
		expect(again.result?.stop).toMatchObject({ kind: "spec-signoff" });
		expect(signoffs()).toEqual([]);
		expect(landedOrder(run.rows())).toEqual([]);
		for (const k of WAVE1) expect(run.count(k, "dispatched")).toBe(0);
	},
	LONG,
);

it(
	"D10: Given a child that parks on every attempt and a scripted park answer, Then the drive command answers it from the script only until it has parked three times running on one head, then stops with parked naming the repeats",
	async () => {
		run = await driveRun({ parkAlways: [A] });
		run.answers({
			plan: { approve: true },
			signoff: { approve: true },
			parked: { default: "Carry on." },
		});

		const d = await run.drive();
		expect(d.code, d.err).toBe(10);
		// A redispatch rebased onto B's landing moves A's head but is no new work of A's, so
		// it does not start the count again: three parks, whenever B landed.
		const tries = run.count(A, "dispatched");
		expect(tries).toBe(3);
		expect(d.result?.stop).toMatchObject({
			kind: "parked",
			child: A,
			attempt: tries,
			question: QUESTION,
			repeats: [tries - 2, tries - 1, tries].map((attempt) => ({
				attempt,
				question: QUESTION,
			})),
		});
		const scripted = run
			.rows()
			.filter(
				(r) =>
					r.child === A && r.stage === "decision" && r.data?.kind === "parked",
			);
		expect(scripted).toHaveLength(tries - 1);
		expect(scripted.every((r) => r.data?.by === "eval")).toBe(true);
		// Its sibling went on: drive stops once only its worker is left, and a later drive lands it.
		for (let i = 0; i < 30 && !landedOrder(run.rows()).includes(B); i++)
			await run.drive();
		expect(landedOrder(run.rows())).toEqual([SPINE, B]);
	},
	LONG,
);

it(
	"D11: Given a child redispatched after a sibling landed, Then its worker finds the sibling's file in its worktree",
	async () => {
		run = await driveRun({ park: [A] });
		await run.approvePlan();
		await toSignoff(run);
		await signSpecs(run);
		let parked = await run.drive();
		// Drive stops on the held child as soon as only B's worker is left; B's worker goes
		// on, and a later drive lands it. Drive until it has, before answering A.
		for (let i = 0; i < 30 && !landedOrder(run.rows()).includes(B); i++)
			parked = await run.drive();
		expect(parked.result?.stop, parked.err).toMatchObject({
			kind: "parked",
			child: A,
		});
		expect(landedOrder(run.rows())).toContain(B);

		const note = join(run.root, "answer.txt");
		writeFileSync(note, "Say hello.\n");
		const d = await run.drive("--answer", A, "--note-file", note);
		expect(d.result?.stop.kind, d.err).toBe("epic-ready");
		const mine = run.seen().filter((l) => l.startsWith(`${A}: `));
		expect(mine).toHaveLength(2);
		expect(mine[0]).not.toContain("b.ts");
		expect(mine[1]).toContain("b.ts");
		expect(
			readFileSync(join(runPath(PARENT), `brief-${A}-2.md`), "utf8"),
		).not.toContain("still on its old base");
	},
	LONG,
);

it(
	"D12: Given a child whose acceptance spec cannot pass as written and a scripted park answer, Then the drive command stops with spec-amendment instead of parking it again, and once the amendment is signed off and landed it redispatches the child onto it",
	async () => {
		run = await driveRun({ specClaim: [A] });
		run.answers({
			plan: { approve: true },
			signoff: { approve: true },
			parked: { default: "Carry on." },
		});

		const d = await run.drive();
		expect(d.code, d.err).toBe(10);
		expect(d.result?.stop).toMatchObject({
			kind: "spec-amendment",
			child: A,
			attempt: 1,
			spine: SPINE,
			path: "test/spine.test.ts",
			scenario: "F1",
		});
		// No park loop: one attempt, never answered from the script; its sibling went on.
		const scripted = () =>
			run?.rows().filter((r) => r.child === A && r.stage === "decision")
				.length ?? 0;
		expect(run.count(A, "dispatched")).toBe(1);
		expect(scripted()).toBe(0);
		// Drive stops once only the sibling's worker is left, and a later drive lands it.
		for (let i = 0; i < 30 && !landedOrder(run.rows()).includes(B); i++)
			await run.drive();
		expect(landedOrder(run.rows())).toEqual([SPINE, B]);
		const again = await run.drive();
		expect(again.result?.stop.kind).toBe("spec-amendment");
		expect(run.count(A, "dispatched")).toBe(1);

		const portia = async (...argv: string[]) => {
			const r = await (run as DriveRun).portia(...argv);
			return { ...r, json: r.out ? JSON.parse(r.out) : undefined };
		};
		expect((await portia("amend", "start", A, "--parent", PARENT)).code).toBe(
			0,
		);
		const waited = await portia(
			"amend",
			"wait",
			A,
			"--parent",
			PARENT,
			"--poll",
			"1",
		);
		expect(waited.code, waited.err).toBe(0);
		expect(waited.json).toMatchObject({ status: "done" });
		expect(waited.json.diff).toContain("+\tconst got = spine();");

		const pending = await run.drive();
		expect(pending.result?.stop).toMatchObject({
			kind: "spec-amendment",
			amendment: { status: "done", head: waited.json.head },
		});
		// Not before its sign-off.
		const early = await portia("amend", "land", A, "--parent", PARENT);
		expect(early.code).toBe(11);
		expect(early.err).toContain(`portia signoff specs ${PARENT} --amend ${A}`);
		const signed = await portia("signoff", "specs", PARENT, "--amend", A);
		expect(signed.code, signed.err).toBe(0);
		expect(signed.json).toMatchObject({
			child: A,
			stage: "signoff",
			status: "approved",
			data: { amends: "test/spine.test.ts", commit: waited.json.head },
		});
		const landed = await portia("amend", "land", A, "--parent", PARENT);
		expect(landed.code, landed.err).toBe(0);
		const onTip = execFileSync(
			"git",
			["show", `origin/epic/${PARENT}:test/spine.test.ts`],
			{ cwd: run.repo, encoding: "utf8" },
		);
		expect(onTip).toContain("const got = spine();");
		expect(
			run.rows().find((r) => r.stage === "amend" && r.status === "landed")?.data
				?.diff,
		).toContain("const got = spine();");

		const done = await run.drive();
		expect(done.result?.stop.kind, done.err).toBe("epic-ready");
		expect(run.count(A, "dispatched")).toBe(2);
		expect(
			readFileSync(join(runPath(PARENT), `brief-${A}-2.md`), "utf8"),
		).toContain("test/spine.test.ts was amended on the integration branch");
	},
	LONG,
);
