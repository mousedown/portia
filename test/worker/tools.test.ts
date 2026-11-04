import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileSchema, testProfile } from "../../src/core/config";
import { type Procs, startWorker } from "../../src/worker/detached";
import { ROLE_TOOLS, roleTools, type WorkerRole } from "../../src/worker/tools";
import acme from "../fixtures/profile";

const CORE = ["Bash", "Read", "Edit", "Write", "Grep", "Glob"];
const PLAYWRIGHT = { command: "npx", args: ["@playwright/mcp@0.0.41"] };

const withRoles = (roles: unknown) =>
	ProfileSchema.parse({
		...acme,
		workers: { mode: "detached", roles },
	}).workers;

/** Starts a worker for `role` and returns the argv it ran with and its run dir. */
function launch(role: WorkerRole, workers = testProfile().workers) {
	const dir = mkdtempSync(join(tmpdir(), "portia-tools-"));
	let args: string[] = [];
	const procs: Procs = {
		start: (_cmd, a) => {
			args = a;
			return 4242;
		},
		alive: () => false,
		stop: () => {},
	};
	startWorker(
		{
			dir,
			key: "ACME-2",
			attempt: 1,
			role,
			model: "sonnet",
			worktree: "/wt/ACME-2",
			brief: "the brief",
			workers,
			denyRules: [],
		},
		procs,
	);
	return { dir, args };
}

const flagValue = (args: string[], flag: string) =>
	args[args.indexOf(flag) + 1];

describe("worker role tools", () => {
	it("every role loads only the file tools, search and Bash its brief uses", () => {
		for (const role of Object.keys(ROLE_TOOLS) as WorkerRole[])
			expect(roleTools(testProfile().workers, role)).toEqual({
				tools: CORE,
				mcpServers: {},
			});
	});

	it("each role launches with its tools and no MCP server but the ones it is given", () => {
		for (const role of ["spine", "child", "amend", "fix"] as const) {
			const { dir, args } = launch(role);
			expect(flagValue(args, "--tools")).toBe(CORE.join(","));
			expect(args).toContain("--strict-mcp-config");
			const mcp = flagValue(args, "--mcp-config");
			expect(mcp).toBe(join(dir, "worker-ACME-2-1.mcp.json"));
			expect(JSON.parse(readFileSync(mcp ?? "", "utf8"))).toEqual({
				mcpServers: {},
			});
			// Every flag that takes a list is followed by another flag, so none swallows `-p`.
			expect(args.slice(args.indexOf("--mcp-config") + 2)).toEqual([
				"-p",
				"--model",
				"sonnet",
			]);
		}
	});

	it("the profile extends one role's tools and MCP servers without touching the others", () => {
		const workers = withRoles({
			child: {
				tools: ["WebFetch", "Read"],
				mcpServers: { playwright: PLAYWRIGHT },
			},
		});
		expect(roleTools(workers, "child")).toEqual({
			tools: [...CORE, "WebFetch"],
			mcpServers: { playwright: PLAYWRIGHT },
		});
		expect(roleTools(workers, "spine")).toEqual({
			tools: CORE,
			mcpServers: {},
		});

		const child = launch("child", workers);
		expect(flagValue(child.args, "--tools")).toBe(
			[...CORE, "WebFetch"].join(","),
		);
		expect(
			JSON.parse(
				readFileSync(flagValue(child.args, "--mcp-config") ?? "", "utf8"),
			),
		).toEqual({ mcpServers: { playwright: PLAYWRIGHT } });

		const amend = launch("amend", workers);
		expect(flagValue(amend.args, "--tools")).toBe(CORE.join(","));
		expect(
			JSON.parse(
				readFileSync(flagValue(amend.args, "--mcp-config") ?? "", "utf8"),
			),
		).toEqual({ mcpServers: {} });
	});

	it("the profile refuses an unknown role, an MCP tool named as a built-in, or a stray key", () => {
		const parse = (roles: unknown) =>
			ProfileSchema.safeParse({
				...acme,
				workers: { mode: "detached", roles },
			}).success;
		expect(parse({ child: { tools: ["WebFetch"] } })).toBe(true);
		expect(parse({ reviewer: { tools: ["WebFetch"] } })).toBe(false);
		expect(parse({ child: { tools: ["mcp__playwright__navigate"] } })).toBe(
			false,
		);
		expect(parse({ child: { tool: ["WebFetch"] } })).toBe(false);
		expect(testProfile().workers.roles).toEqual({});
	});
});
