import type { RunRow } from "../../core/types";
import { tokens } from "./format";
import { rowSteps, shortStep } from "./gates";
import type { Phrase, Role } from "./types";

export interface PhraseCtx {
	/** The port of the env this row tears down. */
	port?: number;
	/** How many steps that gate kind has in the run, for "unit ✗ at 3 of 7". */
	steps?: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The first line is the headline; the rest, trimmed, is folded. */
export function split(text: string): { head: string; fold?: string } {
	const lines = text.replace(/\r/g, "").split("\n");
	const head = (lines.shift() ?? "").trim();
	const fold = lines
		.join("\n")
		.replace(/^\s*\n/, "")
		.trimEnd();
	return fold.trim() ? { head, fold } : { head };
}

const modelText = (m?: RunRow["model"]) =>
	m
		? m.actual && m.actual !== m.requested
			? `${m.requested}→${m.actual}`
			: m.requested
		: "";

function gate(row: RunRow, label: string, pass: boolean, ctx: PhraseCtx) {
	const steps = rowSteps(row);
	const detail = pass
		? steps.length <= 4
			? steps.map((s) => `${s.name} ✓`).join("  ")
			: `${steps.length} of ${steps.length} steps passed`
		: steps.map((s) => `${s.name} ${s.ok ? "✓" : "✗"}`).join("  ");
	const failAt = steps.findIndex((s) => !s.ok);
	const total = Math.max(ctx.steps ?? 0, steps.length);
	const short = pass
		? `${steps.length} of ${steps.length}`
		: failAt >= 0
			? `${steps[failAt]?.name} ✗ at ${failAt + 1} of ${total}`
			: detail;
	const compact = steps
		.map((s) => `${shortStep(s.name)} ${s.ok ? "✓" : "✗"}`)
		.join(" ");
	return { label, detail, short, compact, pass };
}

const KIND_WORD: Record<string, string> = {
	failure: "failed attempt",
	parked: "parked question",
	question: "open question",
};

/** Who decided, in words: a rule decides automatically. */
export const byWords = (by: string): string =>
	!by
		? ""
		: by === "rule"
			? "automatically"
			: by === "person"
				? "by a person"
				: by === "eval"
					? "by the scripted person"
					: `by ${by}`;

/** Core's reasons speak of files "outside touches"; on screen they are outside its paths. */
export const plainWhy = (why: string): string =>
	why.replace(/\boutside touches\b/g, "outside its paths");

/** One sentence for one runlog row: every event line in the view comes from here. */
export function phrase(row: RunRow, ctx: PhraseCtx = {}): Phrase {
	const d = row.data ?? {};
	switch (row.stage) {
		case "dispatched": {
			const model = modelText(row.model);
			return {
				glyph: "dispatched",
				label: "dispatched",
				detail: [`attempt ${row.attempt}`, model].filter(Boolean).join(" · "),
				short: model || `attempt ${row.attempt}`,
				role: "running",
			};
		}
		case "env": {
			if (row.status === "up") {
				const parts = [
					str(d.branch),
					d.port !== undefined ? `port ${d.port}` : "",
					d.db ? `db ${str(d.db)}` : "",
				].filter(Boolean);
				return {
					glyph: "envUp",
					label: "env up",
					detail: parts.join(" · "),
					role: "dim",
				};
			}
			if (row.status === "rebased")
				return {
					glyph: "envUp",
					label: "rebased onto the tip",
					detail: `${str(d.from).slice(0, 7)} → ${str(d.to).slice(0, 7)}`,
					role: "dim",
				};
			const port =
				ctx.port ?? (typeof d.port === "number" ? d.port : undefined);
			return {
				glyph: "envDown",
				label: "env down",
				detail: port !== undefined ? `port ${port} released` : "",
				role: "dim",
			};
		}
		case "gate":
		case "epic":
		case "wave-gate": {
			const pass = row.status === "pass";
			const label =
				row.stage === "epic"
					? "epic gate"
					: row.stage === "wave-gate"
						? `wave ${String(d.wave)} gate`
						: d.kind === "task"
							? "task gate"
							: "exit gate";
			const g = gate(row, label, pass, ctx);
			return {
				glyph: row.stage === "epic" ? "epic" : pass ? "pass" : "fail",
				label,
				detail: g.detail,
				short: g.short,
				compact: g.compact,
				role:
					row.stage === "epic"
						? pass
							? "accent"
							: "failed"
						: pass
							? "done"
							: "failed",
			};
		}
		case "result": {
			const status = row.status ?? "failed";
			if (status === "done") {
				const ids = Object.keys((d.evidence as Record<string, string>) ?? {});
				const parts = [
					ids.length ? `evidence for ${ids.join(", ")}` : "",
					row.tokens ? `${tokens(row.tokens)} tokens` : "",
					row.touchesMatched === undefined
						? ""
						: row.touchesMatched
							? "stayed in its paths"
							: "changed files outside its paths",
				].filter(Boolean);
				return {
					glyph: "result",
					label: "result done",
					detail: parts.join(" · "),
					short: ids.length
						? `evidence for ${ids.join(", ")}`
						: parts.join(" · "),
					role: "done",
				};
			}
			const { head, fold } = split(
				str(d.message) || str(d.question) || str(d.reason),
			);
			const parked = status === "parked";
			return {
				glyph: parked ? "parked" : "fail",
				label: parked ? "parked" : "failed",
				detail: head,
				fold,
				role: parked ? "parked" : "failed",
			};
		}
		case "decision": {
			const answer = row.status ?? str(d.answer);
			const kind = str(d.kind);
			const by = str(d.by);
			const why = plainWhy(str(d.why));
			const role: Role =
				answer === "accept" ? "done" : answer === "park" ? "parked" : "running";
			// A decision says what it was about in words, never its raw kind.
			const files = kind === "touches-mismatch";
			const who = byWords(by);
			if (files && answer === "accept")
				return {
					glyph: "accept",
					label: "files ok",
					detail: ["outside paths accepted", who].filter(Boolean).join(" · "),
					extra: why ? ` · ${why}` : undefined,
					short: "outside paths accepted",
					role,
				};
			const about = files
				? "files outside its paths"
				: (KIND_WORD[kind] ?? kind.replace(/-/g, " "));
			const base = [about, who].filter(Boolean).join(" · ");
			if (answer === "answer")
				return {
					glyph: "accept",
					label: "answered",
					detail: base,
					extra: why ? ` · ${why}` : undefined,
					short: about,
					role: "done",
				};
			if (answer === "accept")
				return {
					glyph: "accept",
					label: "accept",
					detail: base,
					extra: why ? ` · ${why}` : undefined,
					short: about,
					role,
				};
			return {
				glyph:
					answer === "retry"
						? "retry"
						: answer === "park"
							? "parked"
							: "accept",
				label: answer || "decision",
				detail: [base, why].filter(Boolean).join(" · "),
				short: [about, why.replace(/^attempt /, "")]
					.filter(Boolean)
					.join(" · "),
				role,
			};
		}
		case "land": {
			const { head, fold } = split(str(d.reason));
			const parked = row.status === "parked";
			return {
				glyph: parked ? "parked" : "fail",
				label: parked ? "land parked" : "land failed",
				detail: head,
				fold,
				role: parked ? "parked" : "failed",
			};
		}
		case "landed": {
			const sha = str(d.sha).slice(0, 7);
			return {
				glyph: "pass",
				label: "landed",
				detail: [d.pr !== undefined ? `#${d.pr}` : "", sha]
					.filter(Boolean)
					.join(" · "),
				role: "landed",
			};
		}
		case "approval":
		case "signoff": {
			const approved = row.status === "approved";
			const what = row.stage === "approval" ? "plan" : "specs";
			const waited = Number(d.waitedMinutes);
			return {
				glyph: approved ? "accept" : "parked",
				label: approved
					? row.stage === "approval"
						? "plan approved"
						: "specs signed off"
					: `${what} sent back`,
				detail: [
					byWords(str(d.by)),
					str(d.commit).slice(0, 7),
					waited > 0 ? `waited ${Math.round(waited)}m` : "",
				]
					.filter(Boolean)
					.join(" · "),
				extra: str(d.note) ? ` · ${str(d.note)}` : undefined,
				role: approved ? "done" : "parked",
			};
		}
		case "amend": {
			const landed = row.status === "landed";
			const failed = row.status === "failed";
			return {
				glyph: failed ? "fail" : landed ? "pass" : "accept",
				label: `spec amendment ${String(row.status ?? "")}`,
				detail: [str(d.spec), str(d.commit ?? d.head).slice(0, 7)]
					.filter(Boolean)
					.join(" · "),
				role: failed ? "parked" : landed ? "done" : "dim",
			};
		}
		case "tracker": {
			const failed = row.status === "failed";
			return {
				glyph: failed ? "fail" : "accept",
				label: failed ? "ticket not moved" : "ticket moved",
				detail: failed ? str(d.jiraError) : str(d.state),
				role: "dim",
			};
		}
		default:
			return {
				glyph: "accept",
				label: String(row.stage),
				detail: "",
				role: "dim",
			};
	}
}
