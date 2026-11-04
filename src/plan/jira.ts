import { isDryRun } from "../core/exec";
import { PortiaProblem } from "../core/exit";
import { withPlanBlockAdf } from "./adf";

export interface JiraConfig {
	baseUrl: string;
	email: string;
	token: string;
}
interface JiraLink {
	type: { name: string };
	inwardIssue?: { key: string };
	outwardIssue?: { key: string };
}
export interface JiraIssue {
	key: string;
	fields: {
		summary: string;
		description: unknown;
		issuelinks?: JiraLink[];
		status?: { name: string; statusCategory?: { key: string } };
		labels?: string[];
	};
}
const FIELDS = "summary,description,issuelinks,status,labels";

export function jiraFromEnv(
	env: Record<string, string | undefined> = process.env,
): JiraConfig {
	const baseUrl = env.JIRA_BASE_URL,
		email = env.JIRA_EMAIL,
		token = env.JIRA_API_TOKEN;
	if (!baseUrl || !email || !token)
		throw new PortiaProblem(
			"JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be set",
		);
	return { baseUrl: baseUrl.replace(/\/$/, ""), email, token };
}

export function blockedBy(issue: JiraIssue): string[] {
	return (issue.fields.issuelinks ?? [])
		.filter((l) => l.type.name === "Blocks" && l.inwardIssue)
		.map((l) => l.inwardIssue?.key ?? "");
}

export interface JiraCallOpts {
	/** Each request is abandoned after this long. */
	timeoutMs?: number;
	/** Runs of a GET in all; a write is never repeated. */
	attempts?: number;
	/** The wait before a GET's second run; it doubles before each later one. */
	backoffMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

/** Statuses a GET is worth repeating for: rate limiting and the server's own failures. */
const RETRY_STATUS = (s: number) => s === 429 || s >= 500;

export class Jira {
	private readonly timeoutMs: number;
	private readonly attempts: number;
	private readonly backoffMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		private readonly cfg: JiraConfig,
		private readonly fetchFn: typeof fetch = fetch,
		opts: JiraCallOpts = {},
	) {
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.attempts = opts.attempts ?? 3;
		this.backoffMs = opts.backoffMs ?? 1_000;
		this.sleep =
			opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
	}

	private async call<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		if (isDryRun() && method !== "GET") {
			console.error(`[dry-run] Jira ${method} ${path}`);
			return undefined as T;
		}
		const send = () =>
			this.fetchFn(`${this.cfg.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Basic ${btoa(`${this.cfg.email}:${this.cfg.token}`)}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		// Only a GET is repeated: a POST or PUT that timed out may have landed, and a
		// comment or link sent twice would show twice.
		const tries = method === "GET" ? this.attempts : 1;
		let res: Response;
		for (let n = 1; ; n++) {
			try {
				res = await send();
				if (n >= tries || !RETRY_STATUS(res.status)) break;
			} catch (e) {
				// A network failure or the timeout: thrown as before once tries run out.
				if (n >= tries) throw e;
			}
			await this.sleep(this.backoffMs * 2 ** (n - 1));
		}
		if (!res.ok)
			throw new PortiaProblem(
				`Jira ${method} ${path.split("?")[0]} returned ${res.status}`,
			);
		return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
	}

	issue(key: string): Promise<JiraIssue> {
		return this.call("GET", `/rest/api/3/issue/${key}?fields=${FIELDS}`);
	}

	async children(parent: string): Promise<JiraIssue[]> {
		const jql = encodeURIComponent(`parent = ${parent} ORDER BY key`);
		const r = await this.call<{ issues: JiraIssue[] }>(
			"GET",
			`/rest/api/3/search/jql?jql=${jql}&fields=${FIELDS}&maxResults=100`,
		);
		return r.issues;
	}

	async comment(key: string, text: string): Promise<void> {
		const content = text.split("\n\n").map((p) => ({
			type: "paragraph",
			content: [{ type: "text", text: p }],
		}));
		await this.call("POST", `/rest/api/3/issue/${key}/comment`, {
			body: { type: "doc", version: 1, content },
		});
	}

	async transition(key: string, name: string): Promise<void> {
		const r = await this.call<{
			transitions: { id: string; name: string; to?: { name: string } }[];
		}>("GET", `/rest/api/3/issue/${key}/transitions`);
		const t = r.transitions.find((x) => x.name === name || x.to?.name === name);
		if (!t)
			throw new PortiaProblem(
				`${key}: no transition named '${name}' (available: ${r.transitions.map((x) => x.name).join(", ")})`,
			);
		await this.call("POST", `/rest/api/3/issue/${key}/transitions`, {
			transition: { id: t.id },
		});
	}

	/** Reads then writes the whole description, so a human edit landing in between is lost (no version check). */
	async setPlanBlock(key: string, block: string): Promise<void> {
		const { fields } = await this.issue(key);
		await this.call("PUT", `/rest/api/3/issue/${key}`, {
			fields: { description: withPlanBlockAdf(fields.description, block) },
		});
	}

	/** Creates "blocked is blocked by blocker" unless the link is already there. */
	async link(blocker: string, blocked: string): Promise<void> {
		if (blockedBy(await this.issue(blocked)).includes(blocker)) return;
		await this.call("POST", "/rest/api/3/issueLink", {
			type: { name: "Blocks" },
			inwardIssue: { key: blocker },
			outwardIssue: { key: blocked },
		});
	}
}
