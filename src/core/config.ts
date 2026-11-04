import { homedir } from "node:os";
import { join } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import { PortiaProblem } from "./exit";
import { findProfileFile, type LocateOpts } from "./profile-file";
import { DEFAULT_TEST_GLOBS } from "./ripple";
import { commandWords } from "./words";

/** `<module path relative to the package's e2e dir>#<exportName>`, e.g. `accounts/personas#newMember`. */
const PERSONA_TARGET = /^([A-Za-z0-9_-][A-Za-z0-9_./-]*)#([A-Za-z_$][\w$]*)$/;
export function parsePersonaTarget(
	target: string,
): { module: string; name: string } | undefined {
	const [, module, name] = PERSONA_TARGET.exec(target) ?? [];
	return module && name && !module.includes("..")
		? { module, name }
		: undefined;
}

const Lane = z.enum(["light", "full"]);
const Step = z.object({
	name: z.string(),
	cmd: z.string(),
	heavy: z.boolean(),
	cwd: z.enum(["package", "root"]),
	/** The step runs only when a changed file matches one of these globs; otherwise it is skipped. */
	whenTouches: z.array(z.string()).optional(),
	/** Extra runs after a failure, for steps that fail under load for reasons unrelated to the change. */
	retries: z.number().int().nonnegative().optional(),
	/** The lanes the step runs in at a child's task and exit gates; the epic gate runs every step. */
	lanes: z.array(Lane).nonempty().optional(),
});
const Service = z.object({
	name: z.string(),
	image: z.string(),
	args: z.array(z.string()),
	containerPort: z.number().int().positive(),
	/** The service starts only when a child touches one of these globs. */
	whenTouches: z.array(z.string()),
	/** Lines written to .env.portia; "{port}" becomes the service's host port. */
	env: z.record(z.string(), z.string()),
});
const DebtRule = z.object({
	name: z.string(),
	/** Regex source tested against each added line. */
	pattern: z.string(),
	/** Regex source; files it matches are exempt. */
	exclude: z.string().optional(),
});
/** What the profile adds to one worker role's tools. */
const RoleTools = z
	.object({
		/** Built-in tool names, e.g. "WebFetch". An MCP tool comes with its server. */
		tools: z
			.array(
				z
					.string()
					.min(1)
					.refine((t) => !t.startsWith("mcp__"), {
						message: "an MCP tool is loaded by naming its server in mcpServers",
					}),
			)
			.default([]),
		/** MCP servers by name, each as a `.mcp.json` entry (`{ command, args }` or `{ type, url }`). */
		mcpServers: z
			.record(
				z.string().regex(/^[A-Za-z0-9_-]+$/),
				z.record(z.string(), z.unknown()),
			)
			.default({}),
	})
	.strict();
const Workers = z
	.object({
		/** "subagent": the orchestrator starts each worker in its own session; "detached": the CLI starts a headless process that outlives it. */
		mode: z.enum(["subagent", "detached"]).default("subagent"),
		/** The headless command a detached worker runs; it gets the brief on stdin. */
		command: z.string().default("claude"),
		/** Arguments before Portia's own `--settings <file> --add-dir <run dir> --tools <role's tools> --strict-mcp-config --mcp-config <file> -p --model <model>`. stream-json keeps the log moving and reports the tokens. */
		args: z
			.array(z.string())
			.default(["--output-format", "stream-json", "--verbose"]),
		/** Minutes with no log output, no worktree change and an idle process tree before a detached worker counts as stalled. */
		stallMin: z.number().positive().default(20),
		/**
		 * Claude logins detached workers rotate over, each its own `CLAUDE_CONFIG_DIR`, or the default
		 * login without one. An account at its usage limit is skipped until it resets, and one that is
		 * not logged in until it is cleared. Empty: every worker uses the CLI's own login.
		 */
		accounts: z
			.array(
				z
					.object({
						name: z
							.string()
							.regex(/^[A-Za-z0-9._-]+$/, "letters, digits, '.', '_' or '-'"),
						configDir: z.string().min(1).optional(),
					})
					.strict(),
			)
			.default([])
			.refine((a) => new Set(a.map((x) => x.name)).size === a.length, {
				message: "account names must be unique",
			}),
		/** Minutes an account is skipped after a usage limit whose message names no reset time. */
		limitCooldownMin: z.number().positive().default(60),
		/**
		 * What each detached worker role loads beyond its own built-in tools (see `ROLE_TOOLS`):
		 * more built-ins, and the MCP servers it may use, as in a `.mcp.json`'s `mcpServers`.
		 * No other MCP server is loaded.
		 */
		roles: z
			.object({
				spine: RoleTools.optional(),
				child: RoleTools.optional(),
				amend: RoleTools.optional(),
				fix: RoleTools.optional(),
			})
			.strict()
			.default({}),
	})
	.refine((w) => w.mode === "detached" || w.accounts.length === 0, {
		message:
			'accounts need mode "detached": a subagent runs under the orchestrator\'s own login',
		path: ["accounts"],
	});
/** A review of each child's diff at the head that passed its exit gate, before it lands. */
const ChildReview = z
	.object({
		/** Shell command; exit 0 clean, 1 findings, anything else (or a timeout) an error. */
		cmd: z.string().min(1),
		/** At most 24 hours; a longer timer would overflow setTimeout and fire at once. */
		timeoutMs: z
			.number()
			.int()
			.positive()
			.max(24 * 60 * 60_000)
			.default(20 * 60_000),
		/** Findings fail the land (a retry's brief carries them) or park the child for a person. */
		onFindings: z.enum(["fail", "park"]).default("fail"),
	})
	.strict();
/**
 * How a park for the person is announced. `onPark` replaces the desktop notification: it is
 * split into words as a shell would and run without one, each placeholder filled in its word.
 */
const Notify = z
	.union([
		z.literal(false),
		z
			.object({
				onPark: z
					.string()
					.min(1)
					.refine((c) => commandWords(c) !== undefined, {
						message: "an unterminated quote or a trailing backslash",
					})
					.optional(),
				/** Minutes before a question still unanswered is announced once more. */
				remindMin: z.number().positive().default(30),
			})
			.strict(),
	])
	.default({ remindMin: 30 });
/** The secret scan of a child's added lines: the built-in rules always run; `cmd` adds an external scanner. */
const SecretScan = z
	.object({
		/** Shell command run in the worktree; `{base}` and `{head}` are substituted. Non-zero exit fails. */
		cmd: z.string().min(1).optional(),
		/** Globs of files the built-in rules skip, such as test fixtures holding fake keys. */
		allow: z.array(z.string()).default([]),
	})
	.strict();
export type ServiceSpec = z.infer<typeof Service>;
export type DebtRuleSpec = z.infer<typeof DebtRule>;
const ProfileFields = z.object({
	repo: z.string(),
	/**
	 * Prefix of every branch Portia pushes (`<prefix>/<KEY>`) and of the GitHub tracker labels.
	 * Changing it mid-run orphans that run's branches: finish or rename them before switching.
	 */
	branchPrefix: z
		.string()
		.regex(/^[a-z][a-z0-9-]*$/)
		.refine(
			(v) => v !== "main" && v !== "master",
			"branchPrefix must not be a default branch name (main, master)",
		)
		.default("portia"),
	tracker: z
		.discriminatedUnion("kind", [
			z.object({ kind: z.literal("jira") }),
			z.object({
				kind: z.literal("github"),
				repo: z.string(),
				keyPrefix: z
					.string()
					.regex(/^[A-Z][A-Z0-9]+$/)
					.refine((k) => k !== "EXT", "EXT is reserved for external tickets")
					.optional(),
				/**
				 * `number` (default): a key is `<keyPrefix>-<issue number>`. `title`: a key is the
				 * `<KEY>:` or `[<KEY>]` an issue title starts with, so it need not be the number.
				 */
				keys: z.enum(["number", "title"]).optional(),
			}),
		])
		.default({ kind: "jira" }),
	packageDir: z.string(),
	worktreesDir: z.string(),
	waveCap: z.number().int().positive(),
	minFreeMb: z.number().nonnegative(),
	/** Memory one worker needs; when set, dispatch sizes each wave from free memory and other runs. */
	perWorkerMb: z.number().positive().optional(),
	ports: z.tuple([z.number(), z.number()]),
	db: z
		.object({
			pg: z.object({
				host: z.string(),
				port: z.number(),
				user: z.string(),
				password: z.string(),
				prefix: z.string(),
			}),
			migrate: z.object({
				cmd: z.string(),
				/** "root", "package", or a path relative to the repo root. */
				cwd: z.string(),
			}),
		})
		.optional(),
	/** Env var names that each receive the worker's port. */
	portEnv: z.array(z.string()),
	services: z.array(Service),
	debt: z.array(DebtRule),
	models: z.object({
		high: z.string(),
		standard: z.string(),
		/**
		 * Optional: a cheaper model for a standard-tier child sized XS or S (never the spine).
		 * Absent, those children run on `standard` like the rest.
		 */
		small: z.string().optional(),
	}),
	transitions: z.object({ running: z.string(), landed: z.string() }),
	/** Short lines for the "Environment" section at the end of every worker brief. */
	briefNotes: z.array(z.string()).default([]),
	/** Env vars for every gate step; a worker's .env.portia overrides them. */
	gateEnv: z.record(z.string(), z.string()).default({}),
	gates: z.object({
		task: z.array(Step),
		exit: z.array(Step),
		epic: z.array(Step),
		secretScan: SecretScan.optional(),
	}),
	allowedIncidental: z.array(z.string()),
	/**
	 * What a file outside a child's touches is: `tests` globs mark test-only files (specs,
	 * fixtures, test setup), `generated` globs mark generated output; everything else is production.
	 */
	ripple: z
		.object({
			tests: z.array(z.string()).default([...DEFAULT_TEST_GLOBS]),
			generated: z.array(z.string()).default([]),
		})
		.strict()
		.prefault({}),
	sensitiveGlobs: z.array(z.string()),
	design: z.object({
		pass: z.number(),
		fail: z.number(),
		personas: z.record(
			z.string(),
			z.string().refine((t) => parsePersonaTarget(t) !== undefined, {
				message: "must be '<module relative to e2e>#<exportName>'",
			}),
		),
	}),
	secondVendor: z.string(),
	/** Optional: absent, no child is reviewed. Strict, so a misspelt or empty block fails. */
	review: z.object({ child: ChildReview }).strict().optional(),
	agentBrowser: z.string(),
	jev: z.object({ enabled: z.boolean(), url: z.string().optional() }),
	spend: z.object({ worker: z.number(), wave: z.number(), epic: z.number() }),
	ci: z.boolean().default(true),
	/** Max ms a PR's checks may take to register; a missing check fails sooner once no CI run for the head is active. */
	ciWaitMs: z
		.number()
		.positive()
		.default(5 * 60_000),
	/** Minutes a PR's CI may stay pending before the landing fails. */
	checksTimeoutMin: z.number().positive().default(45),
	/** The CI check names a landing waits on; empty means every check gates. */
	ciChecks: z.array(z.string()).default([]),
	/** A child merges only onto the integration tip it was gated against; if that moved, it rebases and gates again. */
	landOnGatedTip: z.boolean().default(false),
	/**
	 * Optional: an epic of at most `maxChildren` children, none of them a design child, lands
	 * each child by pushing its gated tree onto the integration branch as one commit, fast
	 * forward only, with no PR or CI wait per child. CI still runs on the epic PR before main.
	 */
	directLand: z.object({ maxChildren: z.number().int().positive() }).optional(),
	/**
	 * At land, the exit gate also runs every scenario a child landed earlier in the run made
	 * pass, as a copy of the `{owned}` step named `regression-guard`, so no child breaks another's.
	 */
	regressionGuard: z.boolean().optional(),
	/** The former name of `regressionGuard`, still accepted. */
	ratchet: z.boolean().optional(),
	/**
	 * Optional: absent, waves follow each other as soon as the earlier ones land. Set, these
	 * `gates.epic` steps run once on the integration tip after each wave lands
	 * (`portia gate wave`), and the next wave waits for them to pass.
	 */
	waveGate: z
		.object({ steps: z.array(z.string().min(1)).nonempty() })
		.strict()
		.optional(),
	/**
	 * How children wait for each other. `waves` (the default): a wave starts once every
	 * earlier wave has landed. `needs`: a child starts once the spine, its declared needs
	 * and every earlier-wave child sharing files with it have landed. A `waveGate` keeps
	 * waves strict either way.
	 */
	schedule: z.enum(["waves", "needs"]).default("waves"),
	/**
	 * Who signs off the spine's acceptance specs. `person` (the default): drive stops for
	 * the person every time. `when-clean`: when the spec coupling check finds nothing,
	 * drive records the sign-off itself (by "rule"), so the plan's yes is the one human
	 * checkpoint before the epic PR; anything flagged still stops for the person.
	 */
	specsSignoff: z.enum(["person", "when-clean"]).default("person"),
	maxRetries: z.number().int().nonnegative(),
	// The largest child size the size rule accepts (XS < S < M < L).
	maxSize: z.enum(["XS", "S", "M", "L"]).default("S"),
	/** Children carrying any of these labels (case-insensitive) are never part of a run. */
	excludeLabels: z.array(z.string()).default([]),
	/**
	 * Opt-in. Without it every child is in the full lane unless its block says otherwise.
	 * With it, a child no larger than `maxSize` that is not the spine, has no design check and
	 * touches neither the spine's files nor `sensitiveGlobs` nor `fullTouches` is light.
	 */
	lanes: z
		.object({
			maxSize: z.enum(["XS", "S", "M", "L"]).default("S"),
			fullTouches: z.array(z.string()).default([]),
		})
		.optional(),
	/** Collect every open question with `portia questions` before wave 0; dispatch waits for the answers. */
	askOnce: z.boolean().default(false),
	denyRules: z.array(z.string()),
	workers: Workers.prefault({}),
	notify: Notify,
});
/** The fields, and a `waveGate` naming only steps the epic gate has. */
export const ProfileSchema = ProfileFields.superRefine((p, ctx) => {
	const epic = p.gates.epic.map((s) => s.name);
	for (const [i, name] of (p.waveGate?.steps ?? []).entries())
		if (!epic.includes(name))
			ctx.addIssue({
				code: "custom",
				path: ["waveGate", "steps", i],
				message: `'${name}' is not a gates.epic step (${epic.join(", ") || "none"})`,
			});
}).transform(({ ratchet, regressionGuard, ...p }) => ({
	...p,
	regressionGuard: regressionGuard ?? ratchet ?? true,
}));
export type Profile = z.infer<typeof ProfileSchema>;

/** Whether a touch glob can reach a file a sensitive glob covers, by their static bases. */
function reachesSensitive(touches: string[], sensitive: string[]): boolean {
	if (!touches.length || !sensitive.length) return false;
	const hit = picomatch(sensitive, { dot: true });
	const base = (g: string) => picomatch.scan(g).base.replace(/\/$/, "");
	return touches.some((t) => {
		const tb = base(t);
		return (
			hit(t) ||
			hit(tb) ||
			sensitive.some((s) => {
				const sb = base(s);
				return sb === tb || sb.startsWith(`${tb}/`) || tb.startsWith(`${sb}/`);
			})
		);
	});
}

/**
 * The model a child's worker runs on: its tier's, or `models.small` for a child sized XS or
 * S that is not the spine, when the profile names one. The planner's `high` keeps such a
 * child off the small model only when its touches reach a sensitive path, so the same
 * ticket runs on the same model from one plan to the next.
 */
export function modelFor(
	p: Pick<Profile, "models"> & { sensitiveGlobs?: string[] },
	c: {
		tier: "high" | "standard";
		wave: number;
		size?: string;
		touches?: string[];
	},
): string {
	const sized = c.wave > 0 && (c.size === "XS" || c.size === "S");
	const high =
		c.tier === "high" &&
		(!sized ||
			!p.models.small ||
			reachesSensitive(c.touches ?? [], p.sensitiveGlobs ?? []));
	if (sized && !high && p.models.small) return p.models.small;
	return p.models[high ? "high" : "standard"];
}
export type GateStep = z.infer<typeof Step>;
export type ChildReviewSpec = z.infer<typeof ChildReview>;

export function testProfile(): Profile {
	return ProfileSchema.parse({
		repo: "example",
		packageDir: "packages/app",
		worktreesDir: join(homedir(), ".portia", "worktrees"),
		waveCap: 3,
		minFreeMb: 4096,
		ports: [3100, 3199],
		db: {
			pg: {
				host: "localhost",
				port: 5432,
				user: "postgres",
				password: "postgres",
				prefix: "portia",
			},
			migrate: { cmd: "bun run migrate", cwd: "package" },
		},
		portEnv: ["PORT"],
		services: [
			{
				name: "search",
				image: "example/search:1",
				args: ["--data-dir", "/tmp"],
				containerPort: 9000,
				whenTouches: ["packages/app/src/search/**"],
				env: { SEARCH_PORT: "{port}" },
			},
		],
		debt: [],
		models: { high: "opus", standard: "sonnet" },
		transitions: { running: "In Development", landed: "Review/QA" },
		gates: { task: [], exit: [], epic: [] },
		allowedIncidental: ["bun.lock"],
		sensitiveGlobs: ["**/payments/**", "**/auth/**", "**/billing/**"],
		design: { pass: 0.02, fail: 0.1, personas: {} },
		secondVendor: "codex review --base main",
		agentBrowser: "agent-browser check --url {baseUrl}",
		jev: { enabled: false },
		spend: { worker: 2_000_000, wave: 6_000_000, epic: 15_000_000 },
		maxRetries: 1,
		denyRules: [],
	});
}

export async function loadProfile(
	repoRoot: string,
	opts: LocateOpts = {},
): Promise<Profile> {
	return loadProfileFile(findProfileFile(repoRoot, opts));
}

export async function loadProfileFile(file: string): Promise<Profile> {
	let mod: { default?: unknown };
	try {
		mod = await import(file);
	} catch (e) {
		throw new PortiaProblem(
			`could not import ${file}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!mod.default)
		throw new PortiaProblem(`${file} has no default export (the profile)`);
	const parsed = ProfileSchema.safeParse(mod.default);
	if (!parsed.success)
		throw new PortiaProblem(
			`profile ${file} is invalid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`,
		);
	return parsed.data;
}
