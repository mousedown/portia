import { describe, expect, it } from "vitest";
import { deriveStates } from "../../src/core/state";
import type { RunRow } from "../../src/core/types";
import { type DriveView, nextMove } from "../../src/drive/run";
import type { Stop } from "../../src/drive/types";
import type { ResumeAction } from "../../src/resume/resume";
import { child, parent, spine } from "../helpers/plan";

const S = "ACME-1";
const plan = parent([spine(), child("ACME-2"), child("ACME-3")]);

let tick = 0;
const row = (
	key: string,
	o: Partial<RunRow> & Pick<RunRow, "stage">,
): RunRow => ({
	at: new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
	child: key,
	attempt: 1,
	...o,
});
const landed = (key: string) => row(key, { stage: "landed", status: "landed" });
const done = (key: string) =>
	row(key, { stage: "result", status: "done", data: { head: "abc" } });
const dispatched = (key: string) => row(key, { stage: "dispatched" });
const approvedSpecs = row(S, {
	stage: "signoff",
	status: "approved",
	data: { by: "person" },
});

const view = (
	rows: RunRow[],
	o: Partial<
		Pick<DriveView, "actions" | "held" | "slotsFull" | "waveCap">
	> = {},
): DriveView => ({
	plan,
	rows,
	states: deriveStates(plan, rows),
	actions: [],
	waveCap: 2,
	held: new Map(),
	slotsFull: false,
	...o,
});
const alive = (key: string): ResumeAction => ({
	child: key,
	action: "await-worker",
	detail: "pid 1 is working",
});

describe("nextMove", () => {
	it("starts the spine first, alone", () => {
		expect(nextMove(view([]))).toEqual({ do: "start", child: S });
	});

	it("waits on a running worker rather than starting what is not ready", () => {
		expect(nextMove(view([dispatched(S)], { actions: [alive(S)] }))).toEqual({
			do: "wait",
			child: S,
		});
	});

	it("puts a done spine to the sign-off, and lands it only once signed", () => {
		const rows = [dispatched(S), done(S)];
		expect(nextMove(view(rows))).toEqual({
			do: "signoff",
			spine: S,
			attempt: 1,
			head: "abc",
			specs: { F1: "packages/acme-web/e2e/a.e2e.ts" },
		});
		expect(nextMove(view([...rows, approvedSpecs]))).toEqual({
			do: "land",
			child: S,
		});
	});

	it("redispatches a spine whose specs were refused, with the person's note", () => {
		const no = row(S, {
			stage: "signoff",
			status: "rejected",
			data: { note: "F1 asserts too little" },
		});
		expect(nextMove(view([dispatched(S), done(S), no]))).toEqual({
			do: "start",
			child: S,
			note: "F1 asserts too little",
		});
	});

	it("stops on a held sign-off once nothing else is left", () => {
		const stop: Stop = {
			kind: "spec-signoff",
			spine: S,
			attempt: 1,
			head: "abc",
			specs: {},
		};
		expect(
			nextMove(view([dispatched(S), done(S)], { held: new Map([[S, stop]]) })),
		).toEqual({ do: "stop", stop });
	});

	it("starts wave 1 up to the wave cap, then waits", () => {
		const base = [dispatched(S), done(S), approvedSpecs, landed(S)];
		expect(nextMove(view(base))).toEqual({ do: "start", child: "ACME-2" });
		const both = [...base, dispatched("ACME-2")];
		expect(nextMove(view(both, { actions: [alive("ACME-2")] }))).toEqual({
			do: "start",
			child: "ACME-3",
		});
		expect(
			nextMove(view(both, { actions: [alive("ACME-2")], waveCap: 1 })),
		).toEqual({ do: "wait", child: "ACME-2" });
		expect(
			nextMove(view(both, { actions: [alive("ACME-2")], slotsFull: true })),
		).toEqual({ do: "wait", child: "ACME-2" });
	});

	it("lands before it starts or waits, and works around a parked child", () => {
		const parked = row("ACME-2", {
			stage: "result",
			status: "parked",
			data: { message: "Which greeting?" },
		});
		const rows = [
			dispatched(S),
			done(S),
			approvedSpecs,
			landed(S),
			dispatched("ACME-2"),
			parked,
			dispatched("ACME-3"),
			done("ACME-3"),
		];
		expect(nextMove(view(rows))).toEqual({ do: "land", child: "ACME-3" });
		const after = [...rows, landed("ACME-3")];
		expect(nextMove(view(after))).toEqual({
			do: "ask",
			child: "ACME-2",
			attempt: 1,
			question: "Which greeting?",
		});
		const stop: Stop = {
			kind: "parked",
			child: "ACME-2",
			attempt: 1,
			question: "Which greeting?",
		};
		expect(
			nextMove(view(after, { held: new Map([["ACME-2", stop]]) })),
		).toEqual({ do: "stop", stop });
	});

	it("runs a due wave gate before anything else", () => {
		const action: ResumeAction = {
			child: plan.key,
			action: "wave-gate",
			detail: "",
		};
		expect(nextMove(view([], { actions: [action] }))).toEqual({
			do: "wave-gate",
		});
	});

	it("never lands a child whose land another process is running", () => {
		const rows = [dispatched(S), done(S), approvedSpecs];
		const busy: ResumeAction = {
			child: S,
			action: "await-land",
			detail: "portia land is still running for it (pid 9)",
		};
		expect(nextMove(view(rows, { actions: [busy] }))).toMatchObject({
			do: "hold",
			child: S,
			stop: { kind: "error" },
		});
	});

	it("runs the epic gate once every child has landed", () => {
		expect(
			nextMove(view([landed(S), landed("ACME-2"), landed("ACME-3")])),
		).toEqual({ do: "epic-gate" });
	});
});

describe("nextMove with work in the background", () => {
	const base = [dispatched(S), done(S), approvedSpecs, landed(S)];
	const parked: Stop = {
		kind: "parked",
		child: "ACME-3",
		attempt: 1,
		question: "which zone?",
	};
	const busyView = (
		rows: RunRow[],
		busy: [string, "land" | "wait"][],
		o: Parameters<typeof view>[1] = {},
	) => ({ ...view(rows, o), busy: new Map(busy) });

	it("starts another child while one lands in the background", () => {
		const rows = [...base, dispatched("ACME-2"), done("ACME-2")];
		expect(nextMove(busyView(rows, [["ACME-2", "land"]]))).toEqual({
			do: "start",
			child: "ACME-3",
		});
	});

	it("settles once everything left is already under way", () => {
		const rows = [...base, dispatched("ACME-2"), dispatched("ACME-3")];
		expect(
			nextMove(
				busyView(
					rows,
					[
						["ACME-2", "wait"],
						["ACME-3", "land"],
					],
					{ actions: [alive("ACME-2")] },
				),
			),
		).toEqual({ do: "settle" });
	});

	it("stops on a held child as soon as only running workers are left", () => {
		const rows = [...base, dispatched("ACME-2")];
		const held = new Map([["ACME-3", parked]]);
		expect(nextMove(view(rows, { actions: [alive("ACME-2")], held }))).toEqual({
			do: "stop",
			stop: parked,
		});
		expect(
			nextMove(
				busyView(rows, [["ACME-2", "wait"]], {
					actions: [alive("ACME-2")],
					held,
				}),
			),
		).toEqual({ do: "stop", stop: parked });
	});

	it("never stops early while a land is under way", () => {
		const rows = [...base, dispatched("ACME-2"), done("ACME-2")];
		const held = new Map([["ACME-3", parked]]);
		expect(nextMove(busyView(rows, [["ACME-2", "land"]], { held }))).toEqual({
			do: "settle",
		});
	});

	it("waits for the background work before a wave gate", () => {
		const rows = [...base, dispatched("ACME-2")];
		const gate: ResumeAction = {
			child: "ACME-0",
			action: "wave-gate",
			detail: "wave 0",
		};
		expect(
			nextMove(busyView(rows, [["ACME-2", "wait"]], { actions: [gate] })),
		).toEqual({ do: "settle" });
	});
});
