import { gateField } from "../model/gates";
import type { ChildView, HomeView, RunView } from "../model/types";
import { initialState } from "../runtime/state";
import { homeRuns } from "../select";

// Runlog text is agent output: no C0/C1 control (ESC, OSC, BEL) reaches the terminal,
// the same rule the painter applies.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** Columns padded to the widest cell plus two; the last is not padded; empty is "-". */
export function table(rows: string[][]): string {
	const clean = rows.map((r) =>
		r.map((c) =>
			c === ""
				? "-"
				: c
						.replace(/\s*\n\s*/g, " ")
						.replace(CONTROL, " ")
						.trimEnd(),
		),
	);
	const widths =
		clean[0]?.map((_, i) =>
			Math.max(...clean.map((r) => [...(r[i] ?? "")].length)),
		) ?? [];
	return clean
		.map((r) =>
			r
				.map((c, i) =>
					i === r.length - 1
						? c
						: c + " ".repeat((widths[i] ?? 0) - [...c].length + 2),
				)
				.join("")
				.trimEnd(),
		)
		.join("\n");
}

const secs = (ms?: number) =>
	ms === undefined || Number.isNaN(ms) ? "" : String(Math.floor(ms / 1000));

export function plainHome(h: HomeView): string {
	const runs = homeRuns(h, initialState());
	return table([
		[
			"RUN",
			"GROUP",
			"STATE",
			"LANDED",
			"TOTAL",
			"TOKENS",
			"PR",
			"LAST_AT",
			"LAST_EVENT",
			"SUMMARY",
		],
		...runs.map((r) => {
			const empty = !r.lastAt;
			return [
				r.key,
				r.group,
				r.glyph,
				empty
					? ""
					: String(r.children.filter((c) => c.state === "landed").length),
				empty ? "" : String(r.children.length),
				empty ? "" : String(r.tokens),
				r.epicPr ? String(r.epicPr) : "",
				r.lastAt ?? "",
				r.lastEvent ?? "",
				r.summary ?? "",
			];
		}),
	]);
}

export function plainRun(r: RunView): string {
	return table([
		[
			"WAVE",
			"CHILD",
			"STATE",
			"PHASE",
			"ATTEMPT",
			"PR",
			"MODEL",
			"TOKENS",
			"ELAPSED_S",
			"GATE",
			"SUMMARY",
		],
		...r.children.map((c) => [
			String(c.wave),
			c.key,
			c.state,
			c.state === "running" ? (c.phase ?? "") : "",
			String(c.attempt),
			c.pr ? String(c.pr) : "",
			c.model?.requested ?? "",
			String(c.tokens),
			secs(c.elapsedMs),
			gateField(c.strip, r.catalog),
			c.summary,
		]),
	]);
}

export function plainChild(c: ChildView): string {
	const events = c.attempts.flatMap((a) => a.events);
	return table([
		["AT", "ATTEMPT", "STAGE", "STATUS", "DETAIL"],
		...events.map((e) => [
			e.at,
			String(e.attempt),
			e.row.stage,
			e.row.stage === "dispatched" ? "" : (e.row.status ?? ""),
			e.phrase.detail,
		]),
	]);
}
