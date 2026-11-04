import { basename } from "node:path";

/**
 * How a spine spec for a scenario a later child delivers ran on the spine's branch: failing on
 * an assertion (what it should do until its feature exists), failing on an error the test code
 * threw (a runtime or matcher error), failing to load (a syntax or import error, before it
 * reaches the system under test), or passing already.
 */
export type SpecRun = "assertion" | "error" | "load" | "passes";

/** The spec never ran a test: a runner's report of a file that failed to load or compile. */
const LOAD = [
	/Cannot find (?:module|package)/i,
	/Could not resolve/i,
	/Failed to (?:load|resolve)/i,
	/Test suite failed to run/i,
	/Unhandled error between tests/i,
	/\bSyntaxError\b/,
	/Export named .* not found/i,
];
/** A test threw before or instead of an assertion: a runtime error, or a matcher misused. */
const THROWN = [
	/\b(?:TypeError|ReferenceError|RangeError)\b/,
	/\bis not a function\b/,
	/\bis not defined\b/,
	/Matcher error/i,
];
/** Lines after an error that may still name where it came from: a code frame and a stack frame. */
const FRAME = 12;

/**
 * Classifies one run of `spec` from its exit code and output. A thrown error counts only when
 * the spec's own file is named within a few lines of it (the runner's code or stack frame), so
 * an error the system under test logged is not taken for one in the test code. `line` is the
 * output line that decided it.
 */
export function specRun(
	spec: string,
	code: number,
	out: string,
): { kind: SpecRun; line?: string } {
	if (code === 0) return { kind: "passes" };
	const lines = out.split("\n");
	const name = basename(spec);
	const at = (re: RegExp[], near: boolean) =>
		lines.findIndex(
			(l, i) =>
				re.some((r) => r.test(l)) &&
				(!near || lines.slice(i, i + FRAME).some((f) => f.includes(name))),
		);
	const load = at(LOAD, false);
	if (load >= 0) return { kind: "load", line: lines[load]?.trim() };
	const thrown = at(THROWN, true);
	if (thrown >= 0) return { kind: "error", line: lines[thrown]?.trim() };
	return { kind: "assertion" };
}

/** One line for a flagged spec: what went wrong and what fixing it takes. */
export const flaggedLine = (
	id: string,
	path: string,
	r: { kind: SpecRun; line?: string },
): string =>
	r.kind === "load"
		? `spec ${path} (${id}) fails before it reaches the system under test, on an error loading the spec itself: ${r.line ?? ""}. Fix the spec so it loads, and fails on an assertion until its feature exists`
		: `spec ${path} (${id}) fails on an error the test code threw, not an assertion about missing behaviour: ${r.line ?? ""}. Fix the spec so it fails on an assertion until its feature exists, and passes once it does`;
