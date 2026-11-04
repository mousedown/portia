import { ms } from "./format";
import { gateRun, kindOf } from "./gates";
import type { Attempt, Event, Outcome } from "./types";

const blank = (n: number, at: string): Attempt => ({
	n,
	startedAt: at,
	events: [],
});

/**
 * Groups one child's events (file order) into attempts. Rows that carry their attempt
 * number go there; `attempt: 0` rows (env, gate, decision) go to the current attempt,
 * except an env up before the first dispatch, which belongs to the attempt it set up.
 */
export function groupAttempts(
	events: Event[],
	running: boolean,
	catalog: { task: string[]; exit: string[] },
): Attempt[] {
	const byN = new Map<number, Attempt>();
	const get = (n: number, at: string) => {
		let a = byN.get(n);
		if (!a) {
			a = blank(n, at);
			byN.set(n, a);
		}
		return a;
	};
	const dispatched = new Set<Attempt>();
	let current: Attempt | undefined;
	let held: Event[] = [];
	for (const e of events) {
		const r = e.row;
		if (r.stage === "dispatched" && r.attempt > 0) {
			const a = get(r.attempt, r.at);
			// An attempt runs from its dispatch, the same basis as the child's elapsed time.
			if (!dispatched.has(a)) a.startedAt = r.at;
			dispatched.add(a);
			if (r.model) a.model = r.model;
			for (const h of held) a.events.push({ ...h, attempt: a.n });
			held = [];
			a.events.push({ ...e, attempt: a.n });
			current = a;
		} else if (r.attempt > 0) {
			const a = get(r.attempt, r.at);
			a.events.push({ ...e, attempt: a.n });
		} else if (!current && r.stage === "env" && r.status === "up") held.push(e);
		else {
			const a = current ?? get(0, r.at);
			a.events.push({ ...e, attempt: a.n });
		}
	}
	if (held.length) {
		const a = current ?? get(0, held[0]?.at ?? "");
		for (const h of held) a.events.push({ ...h, attempt: a.n });
	}
	let list = [...byN.values()].sort((a, b) => a.n - b.n);
	// A synthetic attempt 0 shows only when it is the only one: otherwise its rows join the first.
	const zero = byN.get(0);
	if (zero && list.length > 1) {
		list = list.filter((a) => a.n !== 0);
		const first = list[0];
		if (first) {
			first.events = [
				...zero.events.map((e) => ({ ...e, attempt: first.n })),
				...first.events,
			].sort((a, b) => idx(a) - idx(b));
		}
	}
	list.forEach((a, i) => {
		finish(a, running && i === list.length - 1, catalog);
	});
	return list;
}

const idx = (e: Event) => Number(e.id.split(":").pop());

function finish(
	a: Attempt,
	newestRunning: boolean,
	catalog: { task: string[]; exit: string[] },
): void {
	let outcome: Outcome | undefined;
	let tokens = 0;
	let prev: string | undefined;
	let terminal: string | undefined;
	a.events = a.events.map((e) => {
		const r = e.row;
		if (r.stage === "result" || r.stage === "land" || r.stage === "landed")
			terminal = r.at;
		if (r.stage === "result") {
			// An unknown status reads as failed, as the child's state does.
			outcome =
				r.status === "done" || r.status === "parked" ? r.status : "failed";
			tokens += r.tokens ?? 0;
		} else if (r.stage === "land")
			outcome = r.status === "parked" ? "parked" : "land failed";
		else if (r.stage === "landed") outcome = "landed";
		const kind = kindOf(r);
		if (kind === "task") a.task = gateRun(r, catalog.task);
		if (kind === "exit") a.exit = gateRun(r, catalog.exit);
		const out =
			r.stage === "gate" && prev !== undefined
				? { ...e, durationMs: ms(r.at) - ms(prev) }
				: e;
		prev = r.at;
		return out;
	});
	a.outcome = outcome ?? (newestRunning ? "running" : undefined);
	a.tokens = tokens || undefined;
	// It ends at its terminal row (result, landed or land failed): env and trailing
	// decision rows are not part of how long it took.
	if (a.outcome !== "running") a.endedAt = terminal ?? a.events.at(-1)?.at;
}
