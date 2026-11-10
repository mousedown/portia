import { writeFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { amendCommand } from "../cli/commands/amend";
import { decideCommand } from "../cli/commands/decide";
import { dispatchCommand } from "../cli/commands/dispatch";
import { envCommand } from "../cli/commands/env";
import { epicCommand } from "../cli/commands/epic";
import { gateCommand } from "../cli/commands/gate";
import { landCommand } from "../cli/commands/land";
import { ledgerCommand } from "../cli/commands/ledger";
import { planCommand } from "../cli/commands/plan";
import { questionsCommand } from "../cli/commands/questions";
import { resumeCommand } from "../cli/commands/resume";
import { workerCommand } from "../cli/commands/worker";
import { cliContext, loadForCli } from "../cli/context";
import { approveTouches } from "../core/approvals";
import { PortiaProblem } from "../core/exit";
import { waitOf } from "../core/park";
import { appendRow, readRows } from "../core/runlog";
import { recordSignoff } from "../core/signoff";
import { spendOver } from "../core/spend";
import {
	closedOutsideRun,
	deriveStates,
	landedKeys,
	scheduleOf,
} from "../core/state";
import type { ChildState, ParentPlan, RunRow } from "../core/types";
import { readEpic } from "../land/integration";
import type { Coupling } from "../plan/coupling";
import type { ResumeAction } from "../resume/resume";
import {
	scriptPark,
	scriptPlan,
	scriptQuestions,
	scriptSpecs,
} from "./answers";
import {
	type Called,
	call,
	childNext,
	type Grant,
	PARK_REPEATS,
	parkRepeats,
	planApproved,
	reasonOf,
	specsSignoff,
} from "./steps";
import type { DriveResult, DriveStep, StepName, Stop } from "./types";

/** What drive decides from: the plan, the run log, the states and resume's actions. */
export interface DriveView {
	plan: ParentPlan;
	rows: RunRow[];
	states: Map<string, ChildState>;
	actions: ResumeAction[];
	waveCap: number;
	/** Children whose stop is known this drive: they wait on someone, and drive works around them. */
	held: ReadonlyMap<string, Stop>;
	/** No worker slot is free until a running worker finishes or a child lands. */
	slotsFull: boolean;
	/**
	 * Children with a land or a worker wait under way in the background: skipped, as held
	 * ones are, until it settles. `land` is set for those landing.
	 */
	busy?: ReadonlyMap<string, "land" | "wait">;
	/** The profile's sensitive files: drive never allows one outside a child's touches itself. */
	sensitive?: (file: string) => boolean;
}

/** The next automatic step, or the stop when none is left. */
export type Move =
	| { do: "wave-gate" }
	| { do: "land"; child: string }
	| {
			do: "signoff";
			spine: string;
			attempt: number;
			head: string;
			specs: Record<string, string>;
	  }
	| { do: "ask"; child: string; attempt: number; question: string }
	| { do: "decide"; child: string; reason: string }
	| { do: "start"; child: string; note?: string; grant?: Grant }
	| { do: "wait"; child: string }
	| { do: "hold"; child: string; stop: Stop }
	| { do: "epic-gate" }
	/** Nothing to do but let a background land or wait finish. */
	| { do: "settle" }
	| { do: "stop"; stop: Stop };

/**
 * Drops a held `parked` stop whose child no longer waits on a question: the person
 * answered (from `portia view`, say) while drive was busy elsewhere, so drive restarts
 * the child itself rather than stopping on an answered question.
 */
export function dropAnswered(held: Map<string, Stop>, rows: RunRow[]): void {
	for (const [k, s] of held)
		if (
			s.kind === "parked" &&
			waitOf(rows.filter((r) => r.child === k))?.kind !== "question"
		)
			held.delete(k);
}

/**
 * Picks the next move from the view alone, so a second drive after a crash picks the same
 * one: a due wave gate first, then lands, answers and decisions, fresh workers up to the
 * wave cap, a wait on a running worker, and the epic gate once every child is in. A child
 * landing or waited on in the background is skipped until that settles. A child held for
 * someone stops drive as soon as nothing but running workers is left, and no land is under
 * way: the detached workers go on while the person or the AI answers, and the next drive
 * picks up where they got to.
 */
export function nextMove(v: DriveView): Move {
	const { plan, rows, states, actions, held } = v;
	const busy = v.busy ?? new Map();
	const landing = [...busy.values()].includes("land");
	if (actions.some((a) => a.action === "wave-gate"))
		return busy.size ? { do: "settle" } : { do: "wave-gate" };
	const actionOf = (k: string) =>
		actions.find((a) => a.child === k && a.action !== "record-landed");
	const ranked: { rank: number; move: Move }[] = [];
	const add = (rank: number, move: Move) => ranked.push({ rank, move });
	const running = [...states.values()].filter((s) => s === "running").length;
	const canStart = !v.slotsFull && running < v.waveCap;

	for (const c of plan.children) {
		if (held.has(c.key) || busy.has(c.key)) continue;
		const state = states.get(c.key);
		const action = actionOf(c.key);
		if (action?.action === "await-land") {
			add(1, {
				do: "hold",
				child: c.key,
				stop: { kind: "error", message: `${c.key}: ${action.detail}` },
			});
			continue;
		}
		if (state === "ready") {
			if (canStart) add(4, { do: "start", child: c.key });
			continue;
		}
		if (state === "running") {
			if (action?.action === "await-worker")
				add(5, { do: "wait", child: c.key });
			else if (action?.action === "redispatch")
				add(3, { do: "start", child: c.key });
			continue;
		}
		const n = childNext(rows, c.key, state, plan.children, {
			sensitive: v.sensitive,
		});
		switch (n.next) {
			case "land": {
				if (c.wave !== 0) {
					add(0, { do: "land", child: c.key });
					break;
				}
				const s = specsSignoff(rows, c.key);
				if (s?.signed === "approved") add(0, { do: "land", child: c.key });
				else if (s?.signed === "rejected") {
					if (canStart)
						add(3, {
							do: "start",
							child: c.key,
							note: s.note ?? "The specs were not signed off; rework them.",
						});
				} else if (s)
					add(1, {
						do: "signoff",
						spine: c.key,
						attempt: s.attempt,
						head: s.head,
						specs: c.acceptance,
					});
				break;
			}
			case "reland":
				add(0, { do: "land", child: c.key });
				break;
			case "broken":
				add(1, {
					do: "hold",
					child: c.key,
					stop: {
						kind: "failed",
						child: c.key,
						step: "land",
						reason: `the child review command failed; fix it and drive again: ${n.reason}`,
					},
				});
				break;
			case "limit":
				add(1, {
					do: "hold",
					child: c.key,
					stop: { kind: "error", message: `${c.key}: ${n.text}` },
				});
				break;
			case "ask":
				add(1, {
					do: "ask",
					child: c.key,
					attempt: n.attempt,
					question: n.question,
				});
				break;
			case "amend": {
				const spine = plan.children.find(
					(x) =>
						x.wave === 0 && Object.values(x.acceptance).includes(n.claim.path),
				);
				const { amendment, ...claim } = n.claim;
				add(1, {
					do: "hold",
					child: c.key,
					stop: {
						kind: "spec-amendment",
						child: c.key,
						attempt: n.attempt,
						...(spine ? { spine: spine.key } : {}),
						...claim,
						...(amendment ? { amendment } : {}),
					},
				});
				break;
			}
			case "decide":
				add(2, { do: "decide", child: c.key, reason: n.reason });
				break;
			case "restart":
				if (canStart)
					add(3, {
						do: "start",
						child: c.key,
						note: n.note,
						...(n.grant ? { grant: n.grant } : {}),
					});
				break;
		}
	}
	ranked.sort((a, b) => a.rank - b.rank);
	const first = ranked[0];
	const heldStop = plan.children.map((c) => held.get(c.key)).find(Boolean);
	const onlyWorkers =
		!landing &&
		(!first || first.move.do === "wait") &&
		ranked.every((r) => r.move.do === "wait" || r.move.do === "hold");
	if (heldStop && onlyWorkers && (first || busy.size))
		return { do: "stop", stop: heldStop };
	if (first) return first.move;
	if (busy.size) return { do: "settle" };

	const closed = new Set(closedOutsideRun(plan, rows));
	const landed = landedKeys(rows);
	if (plan.children.every((c) => landed.has(c.key) || closed.has(c.key)))
		return { do: "epic-gate" };
	const stop = plan.children.map((c) => held.get(c.key)).find(Boolean);
	if (stop) return { do: "stop", stop };
	return {
		do: "stop",
		stop: {
			kind: "error",
			message: `nothing left to do automatically, and nothing waits on anyone: ${plan.children
				.map((c) => `${c.key} ${states.get(c.key)}`)
				.join(", ")}`,
		},
	};
}

/** A gate's failing steps from its JSON report, else the command's own reason. */
function gateReason(c: Called): string {
	const steps = c.json?.steps;
	const failing = Array.isArray(steps)
		? (steps as { name?: string; ok?: boolean; tail?: string }[])
				.filter((s) => s.ok === false)
				.map((s) => `${s.name}: ${String(s.tail ?? "").trim()}`)
		: [];
	return failing.join("\n") || reasonOf(c);
}

/** The questions `portia questions` printed as a JSON array, when it did. */
function openQuestions(
	c: Called,
): Extract<Stop, { kind: "questions" }>["questions"] | undefined {
	try {
		const parsed = JSON.parse(c.out.join("\n")) as unknown;
		if (!Array.isArray(parsed)) return undefined;
		return parsed.map(
			(q: { id: string; child?: string; question: string }) => ({
				id: q.id,
				...(q.child ? { child: q.child } : {}),
				question: q.question,
			}),
		);
	} catch {
		return undefined;
	}
}

/** How long `portia worker wait` sleeps between looks at a running worker. */
const WAIT_POLL_SECONDS = "2";

/**
 * `portia drive <PARENT>`: takes every automatic step of the run, one command at a time,
 * until a person or the AI is needed. It keeps no state: each move is picked afresh from
 * the run log and resume's view of GitHub, so a drive killed at any point is driven again
 * from where the log says it is. Lands run one at a time, in this process. Anything that
 * breaks a command stops the drive with that error; nothing is retried blind.
 */
export async function drive(parent: string): Promise<DriveResult> {
	const steps: DriveStep[] = [];
	const step = (
		name: StepName,
		child: string,
		ok: boolean,
		detail: string,
		attempt?: number,
	) =>
		steps.push({
			step: name,
			child,
			...(attempt ? { attempt } : {}),
			ok,
			detail,
			at: new Date().toISOString(),
		});
	const done = (stop: Stop): DriveResult => ({ parent, steps, stop });

	try {
		let loaded: Awaited<ReturnType<typeof loadForCli>>;
		try {
			loaded = await loadForCli(parent);
		} catch (e) {
			if (e instanceof PortiaProblem)
				return done({ kind: "plan", reason: e.message });
			throw e;
		}
		const { plan, dir } = loaded;
		const { profile } = await cliContext();

		if (!planApproved(readRows(dir).rows, plan.key)) {
			const s = await scriptPlan(plan.key, dir);
			if (s.answered === "none")
				return done({
					kind: "plan",
					reason: `the plan waits for the person's yes: portia signoff plan ${plan.key} --from <plan file>`,
				});
			if (s.answered === "no") return done({ kind: "plan", reason: s.reason });
			step("signoff", plan.key, true, s.detail);
		}

		let asked = await call(questionsCommand, [plan.key]);
		if (asked.code !== 0) {
			if (openQuestions(asked)) {
				const s = await scriptQuestions(plan.key);
				if (s.answered === "yes") {
					step("answer", plan.key, true, s.detail);
					asked = await call(questionsCommand, [plan.key]);
				} else if (s.answered === "no")
					return done({ kind: "error", message: s.reason });
			}
			const open = openQuestions(asked);
			if (asked.code !== 0)
				return done(
					open
						? { kind: "questions", questions: open }
						: { kind: "error", message: reasonOf(asked) },
				);
		}

		const held = new Map<string, Stop>();
		// Lands and worker waits run in the background, one per child, so drive dispatches
		// ready children while another lands or a worker finishes. The first stop one of them
		// returns ends the drive, once every land under way has finished.
		const busy = new Map<
			string,
			{ kind: "land" | "wait"; done: Promise<void> }
		>();
		let ended: Stop | undefined;
		const background = (
			child: string,
			kind: "land" | "wait",
			work: () => Promise<Stop | undefined>,
		) => {
			const done = work()
				.then(
					(stop) => {
						if (stop) ended ??= stop;
					},
					(e) => {
						ended ??= {
							kind: "error",
							message: e instanceof Error ? e.message : String(e),
						};
					},
				)
				.finally(() => busy.delete(child));
			busy.set(child, { kind, done });
		};
		const settle = () => Promise.race([...busy.values()].map((b) => b.done));
		let landedHere = false;
		let epicRan = false;
		// Never return with a land half done; a worker wait is safe to leave, its worker goes on.
		const finish = async (stop: Stop) => {
			await Promise.all(
				[...busy.values()].filter((b) => b.kind === "land").map((b) => b.done),
			);
			const final = ended ?? stop;
			if (landedHere && !epicRan) {
				const g = await call(ledgerCommand, [plan.key]);
				step(
					"ledger",
					plan.key,
					g.code === 0,
					g.code === 0 ? "published" : reasonOf(g),
				);
			}
			return done(final);
		};
		const stopAt = (child: string, at: StepName, reason: string) =>
			finish({ kind: "failed", child, step: at, reason });
		let slotsFull = false;
		const sensitive = picomatch(profile.sensitiveGlobs, { dot: true });
		let seen = readRows(dir).rows.length;
		let stuck: string | undefined;
		const args = (child: string, ...extra: string[]) => [
			child,
			"--parent",
			plan.key,
			...extra,
		];

		for (;;) {
			if (ended) return await finish(ended);
			const resumed = await call(resumeCommand, [plan.key]);
			if (resumed.code === 11)
				return await finish({ kind: "error", message: reasonOf(resumed) });
			const actions = (resumed.json?.actions ?? []) as ResumeAction[];
			for (const a of actions)
				if (a.action === "record-landed")
					step("record-landed", a.child, true, a.detail);

			const rows = readRows(dir).rows;
			dropAnswered(held, rows);
			for (const r of rows.slice(seen))
				if (r.stage === "result")
					step(
						"result",
						r.child,
						r.status === "done",
						String(r.data?.message ?? r.status ?? ""),
						r.attempt,
					);
			seen = rows.length;
			const states = deriveStates(plan, rows, scheduleOf(profile));
			const move = nextMove({
				plan,
				rows,
				states,
				actions,
				waveCap: profile.waveCap,
				held,
				slotsFull,
				busy: new Map([...busy].map(([k, b]) => [k, b.kind])),
				sensitive,
			});

			// A move that wrote nothing to the log, taken twice running, would be taken forever.
			// Settling is waiting on work already under way, which always ends.
			const key = JSON.stringify(move);
			if (move.do !== "settle" && stuck === `${key}@${rows.length}`)
				return await finish({
					kind: "error",
					message: `drive made no progress at ${move.do}: ${key}`,
				});
			stuck = `${key}@${rows.length}`;

			switch (move.do) {
				case "stop":
					return await finish(move.stop);
				case "settle":
					await settle();
					break;
				case "hold": {
					held.set(move.child, move.stop);
					// An amendment worker needs no one to start it: start it now, so its diff is
					// ready for review by the time drive stops on it.
					const s = move.stop;
					if (
						s.kind === "spec-amendment" &&
						!s.amendment &&
						profile.workers.mode === "detached"
					) {
						const a = await call(amendCommand, [
							"start",
							s.child,
							"--parent",
							plan.key,
						]);
						step(
							"amend-start",
							s.child,
							a.code === 0,
							a.code === 0
								? `amendment worker pid ${String(a.json?.pid ?? "?")}`
								: reasonOf(a),
							s.attempt,
						);
						if (a.code === 0)
							held.set(s.child, {
								...s,
								amendment: { status: "started" },
							});
					}
					break;
				}
				case "wave-gate": {
					const g = await call(gateCommand, ["wave", plan.key]);
					step(
						"wave-gate",
						plan.key,
						g.code === 0,
						g.code === 0 ? "passed" : gateReason(g),
					);
					if (g.code !== 0)
						return await stopAt(plan.key, "wave-gate", gateReason(g));
					break;
				}
				case "epic-gate": {
					epicRan = true;
					const g = await call(epicCommand, [plan.key]);
					step(
						"epic-gate",
						plan.key,
						g.code === 0,
						g.code === 0 ? "passed" : gateReason(g),
					);
					if (g.code !== 0)
						return await stopAt(plan.key, "epic-gate", gateReason(g));
					const landed = landedKeys(readRows(dir).rows);
					return await finish({
						kind: "epic-ready",
						landed: plan.children
							.map((c) => c.key)
							.filter((k) => landed.has(k)),
						pr: readEpic(dir).epicPr,
					});
				}
				case "land":
					background(move.child, "land", async () => {
						const l = await call(landCommand, args(move.child));
						slotsFull = false;
						if (l.json?.status === "landed") {
							step(
								"land",
								move.child,
								true,
								l.json.pr
									? `PR #${l.json.pr} merged`
									: "pushed onto the integration branch",
							);
							landedHere = true;
						} else if (l.json?.status) {
							step(
								"land",
								move.child,
								false,
								`${l.json.status}: ${String(l.json.reason ?? "")}`,
							);
						} else
							return {
								kind: "failed",
								child: move.child,
								step: "land",
								reason: reasonOf(l),
							} satisfies Stop;
						return undefined;
					});
					break;
				case "decide": {
					const d = await call(decideCommand, [
						"failure",
						...args(move.child, "--reason", move.reason),
					]);
					if (d.code !== 0)
						return await stopAt(move.child, "decide-failure", reasonOf(d));
					step(
						"decide-failure",
						move.child,
						true,
						String(d.json?.answer ?? ""),
					);
					break;
				}
				case "ask": {
					const question = move.question || `${move.child} parked`;
					// The same park again and again: another scripted answer will not move it.
					const repeats = parkRepeats(rows, move.child);
					if (repeats.length >= PARK_REPEATS) {
						held.set(move.child, {
							kind: "parked",
							child: move.child,
							attempt: move.attempt,
							question,
							repeats,
						});
						break;
					}
					const s = await scriptPark(plan.key, move.child, question);
					if (s.answered === "yes")
						step("answer", move.child, true, s.detail, move.attempt);
					else
						held.set(
							move.child,
							s.answered === "no"
								? { kind: "error", message: s.reason }
								: {
										kind: "parked",
										child: move.child,
										attempt: move.attempt,
										question,
									},
						);
					break;
				}
				case "signoff": {
					// The skill's coupling check runs before any sign-off, the script's included: a
					// spec reaching a child its owner does not need is the AI's to settle first.
					const checked = await call(planCommand, [
						"specs",
						plan.key,
						"--json",
					]);
					if (checked.code !== 0)
						return await stopAt(
							move.spine,
							"signoff",
							`the spec coupling check failed: ${reasonOf(checked)}`,
						);
					const coupling = (checked.json?.coupling ?? []) as Coupling[];
					const stop: Stop = {
						kind: "spec-signoff",
						spine: move.spine,
						attempt: move.attempt,
						head: move.head,
						specs: move.specs,
						...(coupling.length ? { coupling } : {}),
					};
					if (coupling.length) {
						held.set(move.spine, stop);
						break;
					}
					// Nothing flagged: the plan's yes was the person's checkpoint, and the specs are
					// read again at the epic PR.
					if (profile.specsSignoff === "when-clean") {
						recordSignoff(dir, {
							kind: "specs",
							child: move.spine,
							attempt: move.attempt,
							approved: true,
							by: "rule",
							commit: move.head,
							note: "signed off by rule: the spec coupling check found nothing",
						});
						step(
							"signoff",
							move.spine,
							true,
							"the specs signed off by rule: nothing flagged",
							move.attempt,
						);
						break;
					}
					const s = await scriptSpecs(plan.key, move.spine);
					if (s.answered === "yes")
						step("signoff", move.spine, true, s.detail, move.attempt);
					else if (s.answered === "no")
						return await stopAt(move.spine, "signoff", s.reason);
					else held.set(move.spine, stop);
					break;
				}
				case "wait":
					background(move.child, "wait", async () => {
						const w = await call(workerCommand, [
							"wait",
							...args(move.child, "--poll", WAIT_POLL_SECONDS),
						]);
						slotsFull = false;
						if (w.code === 11 && !w.json)
							return {
								kind: "failed",
								child: move.child,
								step: "worker-wait",
								reason: reasonOf(w),
							} satisfies Stop;
						step(
							"worker-wait",
							move.child,
							true,
							w.code === 10 ? "superseded" : "finished",
						);
						return undefined;
					});
					break;
				case "start": {
					// Past a cap, dispatch refuses until the person raises it: a spend decision.
					const c = plan.children.find((x) => x.key === move.child);
					const over = c && spendOver(rows, plan, c, profile);
					if (over)
						return await finish({
							kind: "failed",
							child: move.child,
							step: "dispatch",
							reason: `${move.child} is not dispatched: ${over.message}. Raising spend.${over.scope} in the profile is the person's spend decision; drive again after.`,
							spend: { scope: over.scope, spent: over.spent, cap: over.cap },
						});
					const anyAlive = actions.some((a) => a.action === "await-worker");
					const check = await call(
						dispatchCommand,
						args(move.child, "--check"),
					);
					if (check.code === 10) {
						slotsFull = true;
						break;
					}
					if (check.code !== 0)
						return await stopAt(move.child, "dispatch", reasonOf(check));
					const env = await call(envCommand, ["up", ...args(move.child)]);
					if (env.code !== 0) {
						if (anyAlive) {
							slotsFull = true;
							break;
						}
						return await stopAt(move.child, "env-up", reasonOf(env));
					}
					step("env-up", move.child, true, String(env.json?.worktree ?? "up"));
					// Recorded before the dispatch: a crash after it goes again on the grant, once.
					if (move.grant) {
						const { files, owners } = move.grant;
						approveTouches(
							dir,
							move.child,
							files,
							`every child owning it has landed (${owners.join(", ")})`,
							"drive",
						);
						appendRow(dir, {
							child: move.child,
							attempt: 0,
							stage: "grant",
							status: "allowed",
							data: { files, owners },
						});
						step("grant", move.child, true, files.join(", "));
					}
					const d = await call(dispatchCommand, args(move.child));
					if (d.code === 10) {
						slotsFull = true;
						break;
					}
					if (d.code !== 0)
						return await stopAt(move.child, "dispatch", reasonOf(d));
					const attempt = Number(d.json?.attempt);
					step("dispatch", move.child, true, `attempt ${attempt}`, attempt);
					const note: string[] = [];
					if (move.note) {
						const file = join(dir, `answer-${move.child}-${attempt}.md`);
						writeFileSync(file, `${move.note}\n`);
						note.push("--note-file", file);
					}
					const w = await call(workerCommand, [
						"start",
						...args(move.child, ...note),
					]);
					if (w.code !== 0)
						return await stopAt(move.child, "worker-start", reasonOf(w));
					step(
						"worker-start",
						move.child,
						true,
						`pid ${String(w.json?.pid ?? "?")}`,
						attempt,
					);
					break;
				}
			}
		}
	} catch (e) {
		return done({
			kind: "error",
			message: e instanceof Error ? e.message : String(e),
		});
	}
}
