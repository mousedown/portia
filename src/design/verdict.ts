import type { PropCheck, Verdict } from "./types";

export function aggregate(
	checks: PropCheck[],
	pixels: { ratio: number; verdict: Verdict; note: string }[],
	frames: number,
): { verdict: Verdict | "NOT_RUN"; ok: boolean; summary: string } {
	if (frames === 0)
		return {
			verdict: "NOT_RUN",
			ok: false,
			summary:
				"no design frames were loaded; a design not loaded is never a PASS",
		};
	// The one place pixel results are capped: the canvas is a mock rendered
	// against fixtures the worker's DB doesn't have, so pixels never block.
	const capped = pixels.map((p) => ({
		...p,
		verdict: (p.verdict === "FAIL" ? "UNCERTAIN" : p.verdict) as Verdict,
	}));
	// compareProps gives each expected element one "element" check when it is
	// missing, or one "color" check when it is found.
	const missing = checks.filter((c) => c.prop === "element").length;
	const expected = missing + checks.filter((c) => c.prop === "color").length;
	const found = expected - missing;
	const empty = expected > 0 && found * 2 < expected;
	const all = [
		...checks.map((c) => c.verdict),
		...capped.map((p) => p.verdict),
		...(empty ? ["FAIL" as Verdict] : []),
	];
	const verdict: Verdict = all.includes("FAIL")
		? "FAIL"
		: all.includes("UNCERTAIN")
			? "UNCERTAIN"
			: "PASS";
	const lines = [
		...(empty
			? [
					`FAIL page looks empty: found ${found} of ${expected} designed elements`,
				]
			: []),
		...checks
			.filter((c) => c.verdict !== "PASS")
			.map(
				(c) =>
					`${c.verdict} ${c.name} ${c.prop}: expected ${c.expected}, got ${c.actual}`,
			),
		...capped.map((p) => `${p.verdict} pixels (advisory): ${p.note}`),
	];
	return {
		verdict,
		ok: verdict !== "FAIL",
		summary: [`design ${verdict}`, ...lines].join("\n"),
	};
}
