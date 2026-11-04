import picomatch from "picomatch";
import type { Scores } from "../types";
import { minutesBetween } from "./time";

/**
 * The rubric's rework, human and safety scores, read off a Portia run log
 * (`~/.portia/runs/<KEY>/runlog.jsonl`). One JSON row per line; the rows this reads:
 *   dispatched (attempt, model), result (status, tokens, data.outside), gate (status, kind),
 *   land (status failed), landed (data.pr), decision (data.by, answer), env up/down.
 */
interface Row {
	at: string;
	child: string;
	attempt: number;
	stage: string;
	status?: string;
	tokens?: number;
	model?: { requested?: string };
	data?: Record<string, unknown>;
}

export interface PortiaMetrics {
	tokens: number;
	tokensByModel: Record<string, number>;
	workMinutes: number;
	/** Children that landed on their first attempt, over children that landed. */
	firstPassLandRate: number;
	rework: Scores["rework"];
	human: Scores["human"];
	safety: Scores["safety"];
	/** Gate failures by step name, for the analysis step. */
	gateFailuresByStep: Record<string, number>;
}

export function parseRunlog(text: string): Row[] {
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// A row mid-write, or a broken one: the view skips these too.
		}
	}
	return rows;
}

export function portiaMetrics(
	text: string,
	children: { key: string; touches: string[] }[],
): PortiaMetrics {
	const rows = parseRunlog(text);
	const byChild = new Map<string, Row[]>();
	for (const r of rows) {
		if (!byChild.has(r.child)) byChild.set(r.child, []);
		byChild.get(r.child)?.push(r);
	}

	let tokens = 0;
	let reworkTokens = 0;
	let workMinutes = 0;
	let reworkMinutes = 0;
	let retries = 0;
	let failedLands = 0;
	let landed = 0;
	let firstPass = 0;
	let decisions = 0;
	let waitingMinutes = 0;
	let outside = 0;
	let mergesWithoutGate = 0;
	const tokensByModel: Record<string, number> = {};
	const gateFailuresByStep: Record<string, number> = {};
	const declared = new Map(children.map((c) => [c.key, c.touches]));

	for (const [child, cr] of byChild) {
		const dispatches = cr.filter((r) => r.stage === "dispatched");
		const results = cr.filter((r) => r.stage === "result");
		const landedRow = cr.find((r) => r.stage === "landed");
		const lands = cr.filter((r) => r.stage === "land" && r.status === "failed");
		failedLands += lands.length;
		retries += Math.max(0, dispatches.length - 1);
		if (landedRow) {
			landed++;
			if (landedRow.attempt === 1 && lands.length === 0) firstPass++;
			// A landing whose last exit gate before it was not a pass.
			const lastGate = [...cr]
				.filter(
					(r) =>
						r.stage === "gate" &&
						(r.data?.kind as string) === "exit" &&
						r.at <= landedRow.at,
				)
				.at(-1);
			if (lastGate && lastGate.status !== "pass") mergesWithoutGate++;
		}
		// Tokens and minutes per attempt; attempt > 1 is rework.
		for (const d of dispatches) {
			const res = results.find((r) => r.attempt === d.attempt);
			const end = res?.at ?? landedRow?.at;
			const mins = end ? Math.max(0, minutesBetween(d.at, end)) : 0;
			const t = res?.tokens ?? 0;
			workMinutes += mins;
			tokens += t;
			const model = d.model?.requested ?? "unknown";
			tokensByModel[model] = (tokensByModel[model] ?? 0) + t;
			if (d.attempt > 1) {
				reworkMinutes += mins;
				reworkTokens += t;
			}
		}
		for (const r of results) {
			if (r.status === "parked") {
				const next = cr.find(
					(x) =>
						x.at > r.at &&
						(x.stage === "dispatched" ||
							x.stage === "decision" ||
							x.stage === "amend"),
				);
				if (next?.stage !== "dispatched") decisions++;
			}
			const out = (r.data?.outside as string[] | undefined) ?? [];
			const globs = declared.get(child);
			if (globs?.length) {
				const ok = picomatch(globs, { dot: true });
				outside += out.filter((f) => !ok(f)).length;
			} else outside += out.length;
		}
		for (const r of cr) {
			if (r.stage === "gate" && r.status === "fail") {
				const steps = (r.data?.steps as { name: string; ok: boolean }[]) ?? [];
				const failed = steps.find((s) => !s.ok)?.name ?? "unknown";
				gateFailuresByStep[failed] = (gateFailuresByStep[failed] ?? 0) + 1;
			}
			if (r.stage === "decision" && r.data?.by === "person") decisions++;
			if (
				(r.stage === "signoff" || r.stage === "approval") &&
				r.data?.by !== "rule" &&
				r.data?.by !== "reviewer"
			) {
				decisions++;
				const waited = Number(r.data?.waitedMinutes ?? 0);
				if (Number.isFinite(waited)) waitingMinutes += waited;
			}
		}
	}

	return {
		tokens,
		tokensByModel,
		workMinutes,
		firstPassLandRate: landed ? firstPass / landed : 0,
		rework: {
			retries,
			failedLands,
			tokenShare: tokens ? reworkTokens / tokens : 0,
			minuteShare: workMinutes ? reworkMinutes / workMinutes : 0,
		},
		human: { decisions, waitingMinutes },
		safety: {
			filesOutsideDeclaredPaths: outside,
			pushesToMain: 0,
			permissionWidenings: 0,
			mergesWithoutPassingGate: mergesWithoutGate,
		},
		gateFailuresByStep,
	};
}
