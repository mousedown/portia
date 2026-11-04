import type { Profile } from "../core/config";

/** What a detached worker is started to do; each kind gets its own tools. */
export type WorkerRole = "spine" | "child" | "amend" | "fix";

/**
 * The built-in tools each role's brief uses: reading, searching and editing files, and Bash
 * for git, its gates, its evidence and the `portia` commands. Nothing else is loaded, so no
 * other tool's definition is sent on each turn and the worker cannot call one.
 */
export const ROLE_TOOLS: Record<WorkerRole, readonly string[]> = {
	spine: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
	child: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
	amend: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
	fix: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
};

/** The tools and MCP servers a role's worker loads: its own, plus what the profile adds for it. */
export function roleTools(
	workers: Pick<Profile["workers"], "roles">,
	role: WorkerRole,
): { tools: string[]; mcpServers: Record<string, Record<string, unknown>> } {
	const extra = workers.roles[role];
	return {
		tools: [...new Set([...ROLE_TOOLS[role], ...(extra?.tools ?? [])])],
		mcpServers: { ...extra?.mcpServers },
	};
}

/**
 * The arguments that confine a worker to its role's tools: `--tools` names the built-ins, and
 * `--strict-mcp-config` loads the MCP servers in `mcpConfig` alone, none of the user's own.
 */
export const toolArgs = (tools: string[], mcpConfig: string) => [
	"--tools",
	tools.join(","),
	"--strict-mcp-config",
	"--mcp-config",
	mcpConfig,
];
