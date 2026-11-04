import picomatch from "picomatch";
import type { Ripple, RippleKind } from "./types";

/** The profile's `ripple` option: globs for test-only files and for generated output. */
export interface RippleGlobs {
	tests: string[];
	generated: string[];
}

/** Specs, fixtures, mocks and test setup under the names and directories most repos use. */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
	"**/*.{test,spec,itest,e2e}.*",
	"**/{test,tests,spec,specs,specs-it,e2e,__tests__,__mocks__,__fixtures__,fixtures}/**",
	"**/{test-setup,setup-tests,setupTests,vitest.setup,jest.setup}.*",
];

const never = () => false;
const matcher = (globs: string[]) =>
	globs.length ? picomatch(globs, { dot: true }) : never;

/**
 * The one classifier planning, results, land and insights share. Generated output wins over
 * a test glob: a file a generator rewrites is regenerated wherever it lives.
 */
export function rippleClassifier(
	globs: RippleGlobs,
): (file: string) => RippleKind {
	const generated = matcher(globs.generated);
	const test = matcher(globs.tests);
	return (file) =>
		generated(file) ? "generated" : test(file) ? "test" : "production";
}

/** Each file with its kind, in the order given. */
export function classifyRipples(files: string[], globs: RippleGlobs): Ripple[] {
	const kind = rippleClassifier(globs);
	return files.map((file) => ({ file, kind: kind(file) }));
}
