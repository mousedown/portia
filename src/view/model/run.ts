import { join } from "node:path";
import { runMetrics } from "../../core/metrics";
import { waitOf } from "../../core/park";
import { PLAN_LINK_FILE, planUrlOf } from "../../core/plan-link";
import { deriveStates } from "../../core/state";
import type {
	ChildPlan,
	ChildState,
	ParentPlan,
	RunRow,
} from "../../core/types";
import { groupAttempts } from "./attempts";
import { age, ms } from "./format";
import type { ViewFs } from "./fs";
import { failedStep, gateRun, kindOf, stepCatalog, strip } from "./gates";
import { parseLedger } from "./ledger";
import { phaseOf } from "./phase";
import { phrase } from "./phrase";
import { type ParsedLog, parseRunlog } from "./runlog";
import { PLAN_FILE, parsePlanSnapshot } from "./snapshot";
import type {
	Approval,
	ChildView,
	EnvView,
	Event,
	Group,
	LedgerView,
	Role,
	RunGlyph,
	RunView,
	Source,
	WaveView,
} from "./types";
import {
	type LogCache,
	readWorkerFiles,
	sameProcess,
	type WorkerFiles,
	workerFile,
	workerView,
} from "./worker";

const CHILD_STATES = new Set<string>([
	"pending",
	"ready",
	"running",
	"parked",
	"failed",
	"done",
	"landed",
	"closed",
]);

export const LOG = "runlog.jsonl";
export const LEDGER = "ledger-body.md";

/** Everything a run directory holds that the view reads, as text. */
export interface RunFiles {
	key: string;
	dir: string;
	log?: ParsedLog;
	plan?: string;
	ledger?: string;
	ledgerMtime?: number;
	epic?: string;
	/** `plan-link.json`: where the plan's page was published. */
	planLink?: string;
	/** The epic PR's title, asked for only when there is no plan snapshot to title the run. */
	epicTitle?: string;
	ports?: string;
	baseline?: string;
	touches: Record<string, string>;
	envs: Record<string, string>;
	/** Each detached worker's record and log tail, by child key. */
	workers: Record<string, WorkerFiles>;
	/** Whether each orchestrator pid that dispatch recorded is still that process, and its terminal. */
	owners: Record<number, { alive: boolean; tty?: string }>;
	/** `epic.diff` is there for `d` to page. */
	epicDiff: boolean;
	/** Whether each worktree an env or worker record names is still on disk. */
	trees: Record<string, boolean>;
	mtimeMs?: number;
}

export const runDirOf = (home: string, key: string) => join(home, "runs", key);

/** How a live view reads worker logs: incrementally, and only for the child on screen. */
export interface LogReads {
	cache: LogCache;
	/** Whether this child's log lines are wanted now; otherwise its log is only stat'ed. */
	want(run: string, child: string): boolean;
}

/** Reads a run directory. A parsed log can be passed in, so a tail need not re-read it. */
export function gatherRun(
	fs: ViewFs,
	home: string,
	key: string,
	log?: ParsedLog,
	logs?: LogReads,
): RunFiles {
	const dir = runDirOf(home, key);
	const names = fs.list(dir);
	const read = (n: string) => fs.read(join(dir, n));
	const sidecars = (prefix: string) =>
		Object.fromEntries(
			names
				.filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
				.map((n) => [n.slice(prefix.length, -5), read(n) ?? ""]),
		);
	const text = log ? undefined : read(LOG);
	const parsed = log ?? (text === undefined ? undefined : parseRunlog(text));
	const workers: Record<string, WorkerFiles> = {};
	for (const n of names) {
		const m = /^worker-(.+)\.json$/.exec(n);
		const k = m?.[1];
		// worker-<KEY>-<n>.settings.json and .cpu.json sit beside the record.
		if (!k || k.includes(".") || n !== workerFile(k)) continue;
		const w = readWorkerFiles(fs, dir, k, {
			cache: logs?.cache,
			read: logs ? logs.want(key, k) : true,
		});
		if (w) workers[k] = w;
	}
	const owners: RunFiles["owners"] = {};
	for (const r of parsed?.rows ?? [])
		if (r.stage === "dispatched" && typeof r.data?.pid === "number") {
			const pid = r.data.pid;
			const started = typeof r.data.started === "string" ? r.data.started : "";
			const alive = sameProcess(fs, pid, started || undefined);
			owners[pid] = {
				alive,
				tty: alive ? fs.identity?.(pid)?.tty : undefined,
			};
		}
	const envs = sidecars("env-");
	const trees: Record<string, boolean> = {};
	const tree = (p: unknown) => {
		if (typeof p === "string" && p && !(p in trees)) trees[p] = fs.exists(p);
	};
	for (const text of Object.values(envs))
		tree((json(text) as { worktree?: unknown } | undefined)?.worktree);
	for (const r of parsed?.rows ?? [])
		if (r.stage === "env") tree(r.data?.worktree);
	for (const w of Object.values(workers))
		tree((json(w.record) as { worktree?: unknown } | undefined)?.worktree);
	const plan = read(PLAN_FILE);
	const epic = read("epic.json");
	const epicPr = num((json(epic) as { epicPr?: unknown } | undefined)?.epicPr);
	return {
		key,
		dir,
		log: parsed,
		plan,
		ledger: read(LEDGER),
		ledgerMtime: fs.stat(join(dir, LEDGER))?.mtimeMs,
		epic,
		planLink: read(PLAN_LINK_FILE),
		epicTitle:
			plan === undefined && epicPr !== undefined
				? fs.prTitle?.(
						key,
						epicPr,
						Object.keys(trees).filter((t) => trees[t]),
					)
				: undefined,
		// One pool for every run on the machine, beside the run directories.
		ports: fs.read(join(home, "runs", "ports.json")),
		baseline: read("baseline.json"),
		touches: sidecars("touches-"),
		envs,
		workers,
		owners,
		epicDiff: names.includes("epic.diff"),
		trees,
		mtimeMs: fs.stat(dir)?.mtimeMs,
	};
}

const json = (text?: string): unknown => {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

/** `feat(live-sessions): ACME-944 Simplify the studio` reads as its summary and scope. */
export function titleParts(title: string): { summary: string; scope?: string } {
	const m = /^\w+(?:\(([^)]*)\))?!?:\s*(?:[A-Z][A-Z0-9]+-\d+\s+)?(.*)$/.exec(
		title.trim(),
	);
	if (!m) return { summary: title.trim() };
	return { summary: (m[2] ?? "").trim(), scope: m[1]?.trim() || undefined };
}

function ledgerPlan(
	key: string,
	ledger: Omit<LedgerView, "mtimeMs">,
): ParentPlan {
	const children: ChildPlan[] = [...ledger.rows]
		.sort((a, b) => a.wave - b.wave)
		.map((r) => ({
			key: r.key,
			summary: r.summary,
			wave: r.wave,
			needs: [],
			touches: [],
			requirements: r.requirements.map((q) => q.id),
			evidence: "",
			tier: "standard",
			acceptance: {},
			blockedBy: [],
		}));
	const closed = ledger.rows
		.filter((r) => r.state === "closed")
		.map((r) => r.key);
	return { key, summary: "", scope: "", scenarios: [], children, closed };
}

/** The parent's own rows: the epic gate, and the epic's environment (`<KEY>-EPIC`). */
export const isEpicChild = (key: string, child: string) =>
	child === key || child === `${key}-EPIC`;

function runlogPlan(key: string, rows: RunRow[]): ParentPlan {
	const keys = [...new Set(rows.map((r) => r.child))].filter(
		(k) => !isEpicChild(key, k),
	);
	return {
		key,
		summary: "",
		scope: "",
		scenarios: [],
		children: keys.map((k) => ({
			key: k,
			summary: "",
			wave: 0,
			needs: [],
			touches: [],
			requirements: [],
			evidence: "",
			tier: "standard",
			acceptance: {},
			blockedBy: [],
		})),
	};
}

function approvals(text?: string): Approval[] {
	const v = json(text);
	return Array.isArray(v)
		? v
				.filter((a) => a && typeof a.glob === "string")
				.map((a) => ({
					glob: a.glob,
					at: str(a.at),
					by: str(a.by),
					why: str(a.why),
				}))
		: [];
}

function events(
	key: string,
	rows: RunRow[],
	catalog: RunView["catalog"],
): Event[] {
	const ports = new Map<string, number>();
	return rows.map((row, i) => {
		let port: number | undefined;
		if (row.stage === "env") {
			if (row.status === "up") {
				const p = num(row.data?.port);
				if (p !== undefined) ports.set(row.child, p);
			} else port = ports.get(row.child);
		}
		const kind = kindOf(row);
		return {
			id: `${key}:${i}`,
			at: row.at,
			run: key,
			child: row.child,
			attempt: row.attempt,
			row,
			phrase: phrase(row, {
				port,
				steps: kind ? catalog[kind].length : undefined,
			}),
		};
	});
}

const STATE_ROLE: Record<string, Role> = {
	done: "done",
	parked: "parked",
	failed: "failed",
};

function childView(
	c: ChildPlan,
	ctx: {
		key: string;
		rows: RunRow[];
		events: Event[];
		state: ChildState;
		now: number;
		catalog: RunView["catalog"];
		ledger?: Omit<LedgerView, "mtimeMs">;
		plan?: ParentPlan;
		source: Source;
		states: Map<string, ChildState>;
		files: RunFiles;
		prefix?: string;
	},
): ChildView {
	const { rows, state, now } = ctx;
	const ph = phaseOf(rows, state, now);
	const attempts = groupAttempts(ctx.events, state === "running", ctx.catalog);
	const dispatches = rows.filter((r) => r.stage === "dispatched");
	const results = rows.filter((r) => r.stage === "result");
	const result = results.at(-1);
	const landed = rows.filter((r) => r.stage === "landed").at(-1);
	const ledgerRow = ctx.ledger?.rows.find((r) => r.key === c.key);
	const tokens = results.reduce((s, r) => s + (r.tokens ?? 0), 0);
	// Evidence counts only from an attempt that landed, or the current one once it is done:
	// an attempt rolled back by a land failure proved nothing.
	const landedAttempts = new Set(
		rows.filter((r) => r.stage === "landed").map((r) => r.attempt),
	);
	const rolledBack = new Set(
		rows
			.filter((r) => r.stage === "land" && r.status === "failed")
			.map((r) => r.attempt),
	);
	const counts = (r: RunRow) =>
		landedAttempts.has(r.attempt) ||
		(r === result &&
			r.status === "done" &&
			r.attempt === dispatches.at(-1)?.attempt &&
			!rolledBack.has(r.attempt));
	const withEvidence = results.filter((r) => r.data?.evidence);
	const proven = withEvidence.filter(counts).at(-1);
	const evidence = (proven?.data?.evidence ?? {}) as Record<string, string>;
	const unproven = withEvidence.at(-1);
	const unlandedEvidence =
		unproven && unproven !== proven && !counts(unproven)
			? {
					attempt: unproven.attempt,
					evidence: (unproven.data?.evidence ?? {}) as Record<string, string>,
				}
			: undefined;
	const scenario = new Map(
		(ctx.plan?.scenarios ?? []).map((s) => [s.id, s.text]),
	);
	const requirements = c.requirements.map((id) => ({
		id,
		// Evidence that counts proves it, whatever an older ledger says; else the ledger's cell.
		ok: evidence[id]
			? true
			: ledgerRow
				? (ledgerRow.requirements.find((q) => q.id === id)?.ok ?? null)
				: null,
		text: ctx.source === "plan" ? scenario.get(id) : undefined,
	}));
	const envRows = rows.filter((r) => r.stage === "env");
	const envUp = envRows.filter((r) => r.status === "up").at(-1);
	const envFile = json(ctx.files.envs[c.key]) as
		| Record<string, unknown>
		| undefined;
	const envData = { ...(envUp?.data ?? {}), ...(envFile ?? {}) };
	const newestEnv = envRows.at(-1);
	const env: EnvView | undefined =
		envUp || envFile
			? {
					worktree: str(envData.worktree),
					branch: str(envData.branch),
					db: str(envData.db) || undefined,
					port: num(envData.port),
					up: newestEnv ? newestEnv.status === "up" : true,
					since: newestEnv?.at ?? "",
					exists: ctx.files.trees[str(envData.worktree)],
				}
			: undefined;
	// A land that failed after its PR was opened names the PR: in its data, or its reason.
	const landRow = rows.filter((r) => r.stage === "land").at(-1);
	const landPr =
		landRow && (!landed || ms(landRow.at) > ms(landed.at))
			? (num(landRow.data?.pr) ??
				(() => {
					const m = /\bPR #(\d+)/.exec(str(landRow.data?.reason));
					return m ? Number(m[1]) : undefined;
				})())
			: undefined;
	const messages = rows
		.filter(
			(r) =>
				(r.stage === "result" && r.data?.message) ||
				(r.stage === "land" && r.data?.reason),
		)
		.at(-1);
	const lastMessage = messages
		? {
				text: str(
					messages.stage === "land"
						? messages.data?.reason
						: messages.data?.message,
				),
				role:
					messages.stage === "land"
						? ("failed" as Role)
						: (STATE_ROLE[messages.status ?? ""] ?? "ink2"),
				at: messages.at,
				attempt: messages.attempt,
			}
		: undefined;
	const first = dispatches[0];
	const current = dispatches.at(-1);
	const newest = rows.at(-1);
	const elapsedMs = !first
		? undefined
		: state === "running" && current
			? now - ms(current.at)
			: landed
				? ms(landed.at) - ms(first.at)
				: ms(newest?.at) - ms(first.at);
	let cells = strip(state, ph?.raw, attempts, ctx.catalog);
	if (ph?.phase === "quiet")
		cells = cells.map((x) => (x.kind === "active" ? { kind: "unrun" } : x));
	const decision = rows
		.filter(
			(r) => r.stage === "decision" && r.data?.kind === "touches-mismatch",
		)
		.at(-1);
	const lastModel = rows
		.filter(
			(r) => (r.stage === "dispatched" || r.stage === "result") && r.model,
		)
		.at(-1)?.model;
	return {
		key: c.key,
		summary: c.summary || ledgerRow?.summary || "",
		wave: c.wave,
		state,
		phase: ph?.phase,
		phaseSince: ph?.since,
		attempt: Math.max(0, ...dispatches.map((r) => r.attempt)),
		attempts,
		model: lastModel,
		tokens,
		tokensCounting: state === "running" && tokens > 0,
		pr: landPr ?? num(landed?.data?.pr) ?? ledgerRow?.pr,
		prNote:
			landPr !== undefined
				? landRow?.status === "parked"
					? "land parked"
					: "land failed"
				: undefined,
		sha: str(landed?.data?.sha).slice(0, 7) || undefined,
		requirements,
		touchesMatched: result?.touchesMatched,
		outside: Array.isArray(result?.data?.outside)
			? result.data.outside.map(String)
			: [],
		approvals: approvals(ctx.files.touches[c.key]),
		needs:
			ctx.source === "plan"
				? c.needs.map((n) => ({
						key: n.key,
						state: ctx.plan?.satisfied?.includes(n.key)
							? "landed"
							: (ctx.states.get(n.key) ?? "pending"),
					}))
				: undefined,
		env,
		lastMessage,
		strip: cells,
		elapsedMs,
		quietMs: state === "running" && newest ? now - ms(newest.at) : undefined,
		touchesDecision: decision
			? {
					answer: decision.status ?? str(decision.data?.answer),
					by: str(decision.data?.by),
				}
			: undefined,
		evidence,
		unlandedEvidence,
		touches: ctx.source === "plan" ? c.touches : undefined,
		worker: workerView(rows, ctx.files.workers[c.key], ctx.files.owners, now),
		wait: state === "parked" || state === "failed" ? waitOf(rows) : undefined,
		branch:
			env?.branch ||
			(ctx.prefix && dispatches.length ? `${ctx.prefix}/${c.key}` : undefined),
	};
}

function groupOf(children: ChildView[], epic?: RunRow): Group {
	if (epic?.status === "pass") return "delivered";
	if (children.some((c) => c.wait?.kind === "question")) return "waiting";
	if (children.some((c) => c.state === "running" && c.phase !== "quiet"))
		return "session";
	if (
		children.some((c) => c.state === "parked" || c.state === "failed") ||
		epic?.status === "fail"
	)
		return "judgement";
	return "rest";
}

function glyphOf(
	group: Group,
	children: ChildView[],
	hasRows: boolean,
): RunGlyph {
	if (group === "delivered") return "delivered";
	if (group === "session") return "running";
	if (group === "waiting") return "parked";
	if (group === "judgement")
		return children.some((c) => c.state === "parked") ? "parked" : "failed";
	if (!hasRows) return "empty";
	if (children.some((c) => c.phase === "quiet")) return "quiet";
	if (
		children.length &&
		children.every((c) => c.state === "landed" || c.state === "closed")
	)
		return "landed";
	if (children.some((c) => c.state === "done")) return "done";
	return "ready";
}

function lastEventOf(
	key: string,
	ev: Event | undefined,
	glyph: RunGlyph,
	children: ChildView[],
) {
	if (!ev) return "not started";
	if (glyph === "quiet") {
		const q = children.find((c) => c.phase === "quiet");
		if (q) return `${q.key} quiet ${age(q.quietMs ?? 0)}`;
	}
	const r = ev.row;
	const kind = kindOf(r);
	if (kind) {
		const g = gateRun(r, []);
		const passed = g.steps.filter((s) => s.ok).length;
		const tail = g.pass
			? ` ✓ ${passed}/${g.steps.length}`
			: ` ✗ ${failedStep(g) ?? ""}`.trimEnd();
		if (kind === "epic")
			return g.pass
				? `epic gate ✓ ${g.steps.length} steps`
				: `epic gate ✗ at ${failedStep(g) ?? "?"}`;
		return `${r.child} ${ev.phrase.label}${tail}`;
	}
	return isEpicChild(key, r.child)
		? `epic ${ev.phrase.label}`
		: `${r.child} ${ev.phrase.label}`;
}

/**
 * The profile's branch prefix, read back from the env rows: each one names its branch
 * `<prefix>/<child>`. The view never builds a branch name from a prefix of its own.
 */
export function branchPrefixOf(rows: RunRow[]): string | undefined {
	for (const r of rows) {
		if (r.stage !== "env") continue;
		const b = str(r.data?.branch);
		if (b.endsWith(`/${r.child}`)) return b.slice(0, -r.child.length - 1);
	}
	return undefined;
}

export function buildRun(f: RunFiles, now: number): RunView {
	const rows = f.log?.rows ?? [];
	const snap = f.plan === undefined ? undefined : parsePlanSnapshot(f.plan);
	const parsedLedger =
		f.ledger === undefined ? undefined : parseLedger(f.ledger);
	const ledger: LedgerView | undefined = parsedLedger
		? { ...parsedLedger, mtimeMs: f.ledgerMtime }
		: undefined;
	let source: Source;
	let plan: ParentPlan;
	if (snap) {
		source = "plan";
		plan = snap.plan;
	} else if (ledger) {
		source = "ledger";
		plan = ledgerPlan(f.key, ledger);
	} else if (f.log) {
		source = "runlog";
		plan = runlogPlan(f.key, rows);
	} else {
		source = "empty";
		plan = runlogPlan(f.key, []);
	}
	const catalog = {
		task: stepCatalog(rows, "task"),
		exit: stepCatalog(rows, "exit"),
		epic: stepCatalog(rows, "epic"),
	};
	const all = events(f.key, rows, catalog);
	// A result or land row with a status no writer uses (a hand edit, a newer writer)
	// reads as failed, as core does when the status is missing: never as undefined.
	const states = new Map(
		[
			...deriveStates(plan, rows, {
				waveGate: !!snap?.waveGate,
				byNeeds: !!snap?.byNeeds,
			}),
		].map(([k, v]) => [k, CHILD_STATES.has(v) ? v : ("failed" as ChildState)]),
	);
	const prefix = branchPrefixOf(rows);
	const landedSinceLedger = rows.some(
		(r) =>
			r.stage === "landed" &&
			(f.ledgerMtime === undefined || ms(r.at) > f.ledgerMtime),
	);
	const ordered = [...plan.children].sort((a, b) => a.wave - b.wave);
	const children = ordered.map((c) => {
		let state = states.get(c.key) ?? "pending";
		if (source === "runlog" && state === "ready") state = "pending";
		// The ledger plan has no needs, so deriveStates can call a child ready that is
		// waiting on something outside the run. The ledger's own State cell was derived
		// from the real needs: believe its pending until something lands after it.
		if (
			source === "ledger" &&
			state === "ready" &&
			!landedSinceLedger &&
			ledger?.rows.find((x) => x.key === c.key)?.state === "pending"
		)
			state = "pending";
		return childView(c, {
			key: f.key,
			rows: rows.filter((r) => r.child === c.key),
			events: all.filter((e) => e.child === c.key),
			state,
			now,
			catalog,
			ledger,
			plan,
			source,
			states,
			files: f,
			prefix,
		});
	});
	// Attempt numbers and gate durations come from the grouping: copy them onto the run's events.
	const grouped = new Map<string, Event>();
	for (const c of children)
		for (const a of c.attempts) for (const e of a.events) grouped.set(e.id, e);
	const runEvents = all.map((e) => grouped.get(e.id) ?? e);
	const lowest = Math.min(...children.map((c) => c.wave));
	const waves: WaveView[] = [...new Set(children.map((c) => c.wave))].map(
		(wave) => {
			const list = children.filter((c) => c.wave === wave);
			return {
				wave,
				label:
					source === "runlog"
						? "unplanned"
						: `wave ${wave}${wave === lowest && source !== "empty" ? "  spine" : ""}`,
				children: list,
				landed: list.filter((c) => c.state === "landed").length,
				running: list.filter((c) => c.state === "running").length,
			};
		},
	);
	const epicRows = rows.filter((r) => r.stage === "epic");
	const group = groupOf(children, epicRows.at(-1));
	const glyph = glyphOf(group, children, rows.length > 0);
	const epic = json(f.epic) as { epicPr?: unknown } | undefined;
	const titled =
		source !== "plan" && f.epicTitle ? titleParts(f.epicTitle) : undefined;
	const base = json(f.baseline);
	const ports = json(f.ports);
	return {
		key: f.key,
		summary: source === "plan" ? plan.summary : titled?.summary,
		scope: source === "plan" ? plan.scope : titled?.scope,
		source,
		planAt: snap?.at,
		planUrl: planUrlOf(json(f.planLink)),
		skipped: f.log?.skipped ?? 0,
		group,
		glyph,
		waves,
		children,
		tokens: children.reduce((s, c) => s + c.tokens, 0),
		epicPr: num(epic?.epicPr),
		hasEpicDiff: f.epicDiff,
		branch: prefix ? `${prefix}/${f.key}` : "",
		startedAt: rows[0]?.at,
		lastAt: rows.at(-1)?.at,
		// Env rows are bookkeeping: the last event is the newest row that says something.
		lastEvent: lastEventOf(
			f.key,
			[...runEvents].reverse().find((e) => e.row.stage !== "env") ??
				runEvents.at(-1),
			glyph,
			children,
		),
		epicGates: epicRows.map((r) => gateRun(r, catalog.epic)),
		baseline: Array.isArray(base)
			? base
					.map((b) =>
						typeof b === "string" ? b : str((b as { name?: unknown })?.name),
					)
					.filter(Boolean)
			: [],
		// This run's entries: { port, run, child, pid }.
		ports: Array.isArray(ports)
			? ports
					.filter((e) => (e as { run?: unknown })?.run === f.key)
					.map((e) => (e as { port?: unknown }).port)
					.filter((p): p is number => typeof p === "number")
			: [],
		ledger,
		events: runEvents,
		catalog,
		mtimeMs: f.mtimeMs,
		plan: source === "plan" ? plan : undefined,
		metrics: runMetrics(plan.children, rows),
		questions: children.filter((c) => c.wait?.kind === "question").length,
	};
}

export const readRun = (
	fs: ViewFs,
	home: string,
	key: string,
	now: number,
): RunView => buildRun(gatherRun(fs, home, key), now);
