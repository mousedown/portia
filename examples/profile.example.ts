// An example Portia profile for a fictional monorepo, "acme-web".
//
// Portia ships no project profiles. Put yours in one of these places (first match wins):
//
//   1. PORTIA_PROFILE=/absolute/path/to/profile.ts
//   2. portia.config.ts at the target repository's root
//   3. ~/.portia/profiles/<repo>.ts, where <repo> is the main checkout's folder name
//      (so ~/.portia/profiles/acme-web.ts for this one)
//
// A profile is a module whose default export is a plain object. It is loaded from
// wherever it lives, so import only Node built-ins (or absolute paths), never paths
// relative to Portia's own checkout. Every field is validated by ProfileSchema in
// src/core/config.ts; the fields marked "default" may be left out.

import { homedir, userInfo } from "node:os";
import { join } from "node:path";

// A step's cwd: the app package (packageDir) or the repository root.
const pkg = "package" as const;
const root = "root" as const;

// Several workers gate at once on one machine, so the heavy test steps cap their workers.
const jestLimits = "--maxWorkers=4";

// A workspace package's own suite. `whenTouches` makes the step run only when the
// change reaches one of these globs; otherwise the gate skips it.
const workerPackageTests = {
	name: "worker",
	cmd: `cd packages/worker && bun run build && bunx jest --ci ${jestLimits} --passWithNoTests`,
	heavy: true,
	cwd: root,
	// Retry once: under load a suite can fail for reasons unrelated to the change.
	retries: 1,
	whenTouches: [
		"packages/worker/**",
		// The worker's tests read this app file directly.
		"packages/acme-web/src/jobs/registry.ts",
		"bun.lock",
	],
};

export default {
	// The target repository's name.
	repo: "acme-web",
	// default "portia": every branch Portia pushes is <branchPrefix>/<KEY>.
	branchPrefix: "epic",
	// default { kind: "jira" }. For GitHub Issues:
	//   { kind: "github", repo: "acme/acme-web", keyPrefix: "GH" }
	// keys "GH-42" as issue #42; add keys: "title" to read each key from the start of
	// the issue title instead ("ACME-500: Checkout" or "[ACME-500] Checkout").
	tracker: { kind: "jira" },
	// The app package, relative to the repo root: where `cwd: "package"` steps run.
	packageDir: "packages/acme-web",
	// Where child worktrees are created.
	worktreesDir: join(homedir(), ".portia", "worktrees"),
	// The most workers in flight at once.
	waveCap: 3,
	// A worker's environment is created only while this much memory is free (or reclaimable).
	minFreeMb: 2048,
	// optional: the memory one worker needs, its services included. When set, each dispatch fits the wave to free memory
	// and to the other runs on this machine, never more than waveCap. Unset, only waveCap limits it.
	perWorkerMb: 3072,
	// The port range handed out to workers, one port each.
	ports: [3100, 3199],
	// optional: a Postgres database per worker, cloned from a migrated template.
	db: {
		pg: {
			host: "localhost",
			port: 5432,
			user: process.env.PORTIA_PG_USER ?? userInfo().username,
			password: process.env.PORTIA_PG_PASSWORD ?? "",
			prefix: "portia",
		},
		// Migrates the template database; DATABASE_URL points at it.
		migrate: { cmd: "bun run db:migrate", cwd: "package" },
	},
	// Env var names that each receive the worker's port.
	portEnv: ["PORT"],
	// Containers a worker starts only when its child touches one of `whenTouches`.
	// "{port}" in `env` becomes the container's host port; the lines go to .env.portia.
	services: [
		{
			name: "search",
			image: "acme/search:1",
			args: ["--data-dir", "/tmp", "--api-key", "portia"],
			containerPort: 8108,
			whenTouches: ["packages/acme-web/src/search/**"],
			env: { SEARCH_PORT: "{port}", SEARCH_API_KEY: "portia" },
		},
	],
	// Debt rules: regexes tested against every added line of a child's diff. A file
	// matching `exclude` is exempt. Built-in rules (ticket-history comments, tests that
	// read source) always run as well.
	debt: [
		{
			name: "db-outside-repository",
			pattern: "\\bdb\\.\\w+\\.(find|create|update|delete)\\w*\\(",
			exclude: "/src/server/repositories/",
		},
	],
	// The models the orchestrator assigns: one for the hardest work, one for the rest.
	// Optional `small`: a cheaper model for standard-tier XS/S children (never the spine).
	models: { high: "opus", standard: "sonnet", small: "haiku" },
	// Tracker statuses Portia moves a child to when it starts and when it lands.
	transitions: { running: "In Development", landed: "Review/QA" },
	// default []: the CI checks a landing waits on. Empty means every check gates.
	ciChecks: ["CI gate"],
	// default 5 minutes: how long a PR's checks may take to appear. An aggregate check
	// created only at the end of a long CI run needs more.
	ci: true,
	ciWaitMs: 30 * 60_000,
	// default 45: minutes a PR's CI may stay pending before the landing fails.
	checksTimeoutMin: 45,
	// default false: a child merges only onto the integration tip its rebase was gated
	// against. If another child landed meanwhile, it rebases, gates and waits on CI again.
	landOnGatedTip: true,
	// optional: an epic of at most this many children, none of them a design child, lands
	// each child by a gated fast-forward push onto the integration branch, with no PR or CI
	// wait of its own. CI still runs on the epic PR.
	directLand: { maxChildren: 4 },
	// default true: at land, the exit gate on the rebased head also runs every scenario a
	// child landed earlier in this run made pass, as a copy of the {owned} step named
	// "regression-guard", so no child breaks a sibling's scenario. false runs only the child's own.
	regressionGuard: true,
	// optional: absent, a wave starts as soon as the earlier waves land. Set, these gates.epic
	// steps run once on the integration tip after each wave lands (`portia gate wave`), and
	// the next wave waits for them to pass, so a whole-suite failure no child's slice ran
	// shows up a wave later rather than at the epic gate. {acceptance} becomes the specs
	// whose every scenario has landed, and the steps get PORTIA_WAVE, the wave's number.
	waveGate: { steps: ["unit", "worker"] },
	// default []: lines for the "Environment" section at the end of every worker brief.
	briefNotes: [
		"Load `.env.portia` before running any test suite by hand.",
		"Other workers share this machine: run test suites one at a time.",
		"The acceptance specs are the contract: make your scenarios pass without editing them. If one looks wrong, park.",
	],
	// default {}: env vars for every gate step (a worker's .env.portia overrides them),
	// e.g. a placeholder key that a module needs at import time.
	gateEnv: { PAYMENTS_PUBLIC_KEY: "pk_test_placeholder" },
	// The gates. Placeholders: {files} the child's changed files, {child} and {parent}
	// the keys, {base} the integration branch, {owned} the child's acceptance spec files,
	// {ownedGrep} its scenario ids joined by "|", {acceptance} every acceptance spec.
	gates: {
		// After each task inside a child: fast, scoped to the changed files.
		task: [
			{
				name: "typecheck",
				cmd: "portia gate typecheck-touched {child} --parent {parent}",
				heavy: true,
				cwd: root,
			},
			{ name: "lint", cmd: "bunx eslint {files}", heavy: false, cwd: pkg },
		],
		// Before a child lands on the integration branch.
		exit: [
			{ name: "typecheck", cmd: "bun run typecheck", heavy: true, cwd: pkg },
			{ name: "lint", cmd: "bun run lint", heavy: true, cwd: pkg },
			{
				name: "unit",
				cmd: `bunx jest --ci ${jestLimits} --passWithNoTests`,
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
			workerPackageTests,
			{
				// Test titles start "<id>: "; anchored so F1 never selects F10.
				name: "acceptance",
				cmd: `bunx vitest run {owned} -t "(^| )({ownedGrep}): "`,
				heavy: true,
				cwd: pkg,
				// A light child skips this step; the epic gate still runs every acceptance spec.
				lanes: ["full"],
			},
		],
		// Once, on the whole epic, before its PR is marked ready.
		epic: [
			{ name: "typecheck", cmd: "bun run typecheck", heavy: true, cwd: pkg },
			{ name: "lint", cmd: "bun run lint", heavy: true, cwd: pkg },
			{
				name: "unit",
				cmd: `bunx jest --ci ${jestLimits} --passWithNoTests`,
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
			workerPackageTests,
			{
				name: "acceptance",
				cmd: "bunx vitest run {acceptance}",
				heavy: true,
				cwd: pkg,
				retries: 1,
			},
		],
		// Optional. Credentials in a child's added lines always fail its exit gate and its
		// land; allow lists files the built-in rules skip, and cmd adds an external scanner.
		secretScan: {
			cmd: "gitleaks git --log-opts={base}..{head} --redact --no-banner",
			allow: ["**/test/fixtures/**"],
		},
	},
	// Files a child may change without listing them in its touches.
	allowedIncidental: ["bun.lock"],
	// What a file a child changed outside its touches is. A `tests` match (specs, fixtures,
	// test setup) or a `generated` match rides along as a ripple; anything else is production
	// and parks. Leave `tests` out for the common test globs; `generated` is empty by default.
	ripple: {
		tests: ["**/*.{test,spec}.*", "**/test/**", "**/__fixtures__/**"],
		generated: ["**/generated/**"],
	},
	// A child touching these is never decided by the external evaluator (jev); its
	// decisions fall back to the cautious rule answer.
	sensitiveGlobs: ["**/payments/**", "**/auth/**"],
	// The visual design check: pixel-diff ratios for a pass and a fail, and the persona
	// helpers a design line may name, as "<module relative to the e2e dir>#<export>".
	design: {
		pass: 0.02,
		fail: 0.1,
		personas: { newMember: "accounts/personas#newMember" },
	},
	// An advisory second review, run after the epic gate; {diff} is the epic's diff file.
	secondVendor: "codex review --base main",
	// optional: review each child before it lands, at the head that passed its exit gate.
	// The command runs in the child's worktree with PORTIA_BASE_SHA, PORTIA_HEAD_SHA,
	// PORTIA_DIFF (a file holding the child's diff), PORTIA_CHILD, PORTIA_PARENT and
	// PORTIA_WORKTREE set. Exit 0 is clean, 1 is findings, anything else is an error that
	// parks the child. It may print a JSON line {"findings":[{"severity","message","file","line"}]}.
	review: {
		child: {
			cmd: 'reviewer --diff "$PORTIA_DIFF" --json',
			// default 20 minutes, at most 24 hours; a review that outlasts it counts as an error.
			timeoutMs: 15 * 60_000,
			// default "fail": findings fail the land and a retry's brief carries them;
			// "park" hands them to a person instead.
			onFindings: "fail",
		},
	},
	// A smoke check in a real browser after the epic gate; {baseUrl} and {parent} are filled in.
	agentBrowser:
		"bun run dev > /tmp/portia-{parent}-dev.log 2>&1 & pid=$!; for i in $(seq 1 90); do curl -sf {baseUrl} >/dev/null && break; sleep 2; done; agent-browser open {baseUrl}/; code=$?; agent-browser close; kill $pid; exit $code",
	// An optional external evaluator for the decisions no rule answers.
	jev: { enabled: false },
	// Token budgets per worker, per wave and per epic.
	spend: { worker: 3_000_000, wave: 8_000_000, epic: 20_000_000 },
	// Retries of a failed gate before the child parks.
	maxRetries: 1,
	// default "waves": "needs" starts a child once the spine, its needs and any earlier
	// child sharing its files have landed, rather than waiting for whole waves. A waveGate
	// (as above) keeps waves strict whatever this says.
	schedule: "waves",
	// default "person": "when-clean" lets drive sign off specs the coupling check found
	// clean, so the plan's yes is the one human checkpoint before the epic PR.
	specsSignoff: "person",
	// default "S": the largest child size the plan accepts (XS < S < M < L).
	maxSize: "M",
	// default []: children with any of these labels are never part of a run.
	excludeLabels: ["manual"],
	// optional: a child of size S or smaller that is not the spine, has no design line and
	// touches none of the spine's files, sensitiveGlobs or fullTouches runs in the light
	// lane, skipping the gate steps marked lanes: ["full"]. A block's `lane:` overrides it.
	lanes: {
		maxSize: "S",
		fullTouches: ["packages/acme-web/src/jobs/registry.ts"],
	},
	// default false: ask every open question in one round before wave 0; dispatch waits for the answers.
	askOnce: true,
	// Permission deny rules `portia permissions` adds to .claude/settings.local.json.
	denyRules: [
		"Bash(gh pr merge*)",
		"Bash(git push*main*)",
		"Bash(git push*--force*)",
	],
	// default { mode: "subagent" }: how workers run. A "subagent" worker lives in the
	// orchestrator's session and stops with it. A "detached" worker is a headless process
	// the CLI starts (`portia worker start`) that outlives the orchestrator, which waits
	// on it with `portia worker wait`. A detached worker gets `denyRules` through its own
	// `--settings` file; anything it may run comes from the repository's settings and `args`.
	workers: {
		mode: "subagent",
		// default "claude": the headless command, given the brief on stdin.
		command: "claude",
		// default stream-json output, which keeps the log moving and reports the tokens.
		// Portia adds `--settings <file> --add-dir <run dir> -p --model <model>` after these.
		args: ["--output-format", "stream-json", "--verbose"],
		// default 20: minutes with no log output, no worktree change and an idle process
		// tree before a detached worker counts as stalled; it is stopped and fails with that
		// reason. Keep it longer than the slowest quiet command a worker runs.
		stallMin: 30,
		// default []: detached only. Claude logins workers rotate over, each logged in once
		// with `CLAUDE_CONFIG_DIR=<configDir> claude`. An account at its usage limit is
		// skipped until it resets, and the worker it stopped is retried on another account.
		// accounts: [
		// 	{ name: "work", configDir: "~/.claude-work" },
		// 	{ name: "personal", configDir: "~/.claude-personal" },
		// ],
		// default 60: minutes an account rests after a limit message that names no reset time.
		limitCooldownMin: 60,
	},
	// default { remindMin: 30 }: when a child parks on a question for you, Portia tells you
	// at once with a desktop notification (osascript on macOS, notify-send on Linux), and
	// once more if it is still unanswered after `remindMin` minutes. `onPark` replaces the
	// desktop notification with a command of your own. It is split into words as a shell
	// would, then run without a shell: {parent}, {child}, {question} and {attempt} are filled
	// in inside their word, so a question can never run as a command. The same values are in
	// PORTIA_PARENT, PORTIA_CHILD, PORTIA_QUESTION and PORTIA_ATTEMPT, and PORTIA_REMINDER is
	// 1 on the reminder. `notify: false` switches it off.
	notify: {
		onPark:
			"terminal-notifier -title 'Portia {parent}' -message '{child}: {question}'",
		remindMin: 30,
	},
};
