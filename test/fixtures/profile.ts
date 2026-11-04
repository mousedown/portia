// A fictional profile for the tests: the made-up "acme-web" monorepo, shaped like a real
// one (workspace packages, a search service, CI with one aggregate check).
import { homedir } from "node:os";
import { join } from "node:path";

const pkg = "package" as const;
const root = "root" as const;

const jestLimits = "--maxWorkers=4 --workerIdleMemoryLimit=1024MB";
const vitest = "env -u DATABASE_URL_UNPOOLED";

const shared = [
	"packages/shared-config/**",
	"jest.config.base.cjs",
	"bun.lock",
];
const workspaceTests = [
	{
		name: "notifications",
		cmd: `cd packages/notifications && bunx jest --ci ${jestLimits} --passWithNoTests --testPathIgnorePatterns notifications-stack`,
		heavy: true,
		cwd: root,
		retries: 1,
		whenTouches: [
			"packages/notifications/**",
			"packages/acme-web/src/lib/notify/templates.ts",
			...shared,
		],
	},
	{
		name: "worker",
		cmd: `cd packages/worker && bun run build && bunx jest --ci ${jestLimits} --passWithNoTests`,
		heavy: true,
		cwd: root,
		retries: 1,
		whenTouches: ["packages/worker/**", ...shared],
	},
];

export default {
	repo: "acme-web",
	branchPrefix: "epic",
	tracker: { kind: "jira" },
	packageDir: "packages/acme-web",
	worktreesDir: join(homedir(), ".portia", "worktrees"),
	waveCap: 3,
	minFreeMb: 2048,
	ports: [3100, 3199],
	db: {
		pg: {
			host: "localhost",
			port: 5432,
			user: "postgres",
			password: "",
			prefix: "portia",
		},
		migrate: {
			cmd: 'DATABASE_URL_UNPOOLED="$DATABASE_URL" bun run db:migrate',
			cwd: "package",
		},
	},
	portEnv: ["PORT"],
	services: [
		{
			name: "search",
			image: "acme/search:1",
			args: ["--data-dir", "/tmp", "--api-key", "portia"],
			containerPort: 8108,
			whenTouches: [
				"packages/acme-web/src/lib/search/**",
				"packages/acme-web/src/server/search/**",
			],
			env: {
				SEARCH_PORT: "{port}",
				PUBLIC_SEARCH_PORT: "{port}",
				SEARCH_API_KEY: "portia",
			},
		},
	],
	debt: [
		{
			name: "orm-outside-repository",
			pattern:
				"\\b(db|orm|tx)\\.\\w+\\.(findMany|findFirst|findUnique|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\\(",
			exclude: "/src/server/repositories/|(^|/)(db|specs|specs-it|e2e)/",
		},
	],
	models: { high: "opus", standard: "sonnet" },
	transitions: { running: "In Development", landed: "Review/QA" },
	ciChecks: ["CI gate"],
	ciWaitMs: 45 * 60_000,
	briefNotes: [
		"Load `.env.portia`, then run vitest with `DATABASE_URL_UNPOOLED` unset.",
		"Other workers share this machine: run test suites one at a time, and wait for the load average to drop before `portia gate exit`.",
		"A failure in a spec your diff does not touch is environmental: re-run that gate once.",
		"The acceptance specs are the contract: make your scenarios pass without editing them.",
	],
	gateEnv: { PAYMENTS_PUBLIC_KEY: "pk_test_placeholder" },
	gates: {
		task: [
			{
				name: "typecheck",
				cmd: "portia gate typecheck-touched {child} --parent {parent}",
				heavy: true,
				cwd: root,
			},
			{
				name: "lint",
				cmd: "bunx eslint --cache {files}",
				heavy: false,
				cwd: pkg,
			},
			{
				name: "related-unit",
				cmd: "bunx jest --findRelatedTests {files} --passWithNoTests",
				heavy: false,
				cwd: pkg,
			},
		],
		exit: [
			{ name: "typecheck", cmd: "bun run typecheck", heavy: true, cwd: pkg },
			{ name: "lint", cmd: "bun run lint", heavy: true, cwd: pkg },
			{
				name: "unit",
				cmd: `bunx jest --ci --no-cache ${jestLimits} --passWithNoTests`,
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
			...workspaceTests,
			{
				name: "integration",
				cmd: `${vitest} ACME_SKIP_ACCEPTANCE=1 bunx vitest run --changed {base} --maxWorkers=4 --passWithNoTests`,
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
			{
				name: "acceptance",
				cmd: `${vitest} bunx vitest run {owned} --maxWorkers=4 -t "(^| )({ownedGrep}): "`,
				heavy: true,
				cwd: pkg,
			},
		],
		epic: [
			{ name: "typecheck", cmd: "bun run typecheck", heavy: true, cwd: pkg },
			{ name: "lint", cmd: "bun run lint", heavy: true, cwd: pkg },
			{
				name: "unit",
				cmd: `bunx jest --ci --no-cache ${jestLimits} --passWithNoTests`,
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
			...workspaceTests,
			{
				name: "integration",
				cmd: `${vitest} bunx vitest run --maxWorkers=4 --passWithNoTests`,
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
			{
				name: "acceptance",
				cmd: `${vitest} bunx vitest run {acceptance} --maxWorkers=4`,
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
		],
	},
	allowedIncidental: ["bun.lock"],
	sensitiveGlobs: ["**/payments/**", "**/auth/**", "**/billing/**"],
	design: { pass: 0.02, fail: 0.1, personas: {} },
	secondVendor: "codex review --base main",
	agentBrowser:
		"bun run dev > /tmp/portia-{parent}-dev.log 2>&1 & pid=$!; for i in $(seq 1 90); do curl -sf {baseUrl} >/dev/null && break; sleep 2; done; agent-browser open {baseUrl}/ && agent-browser snapshot; code=$?; agent-browser close; kill $pid; exit $code",
	jev: { enabled: false },
	spend: { worker: 3_000_000, wave: 8_000_000, epic: 20_000_000 },
	maxRetries: 1,
	maxSize: "L",
	excludeLabels: ["launch-readiness"],
	denyRules: [
		"Bash(gh pr merge*)",
		"Bash(git push*main*)",
		"Bash(git push*--force*)",
	],
};
