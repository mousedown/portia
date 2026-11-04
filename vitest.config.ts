import { defineConfig } from "vitest/config";

// Times in `portia view` are local; its tests read them in UTC.
process.env.TZ = "UTC";
// No test announces a park on the desktop of the machine running it.
process.env.PORTIA_NOTIFY = "0";
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// The fixture project's own tests run under bun test inside the e2e suite.
		exclude: ["test/e2e/fixture-repo/**", "**/node_modules/**"],
		testTimeout: 30_000,
	},
});
