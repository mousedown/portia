const FENCE = "`".repeat(3);
interface Node {
	type?: string;
	text?: string;
	attrs?: Record<string, unknown>;
	content?: unknown[];
	marks?: { type?: string; attrs?: Record<string, unknown> }[];
}

/** A link mark's text with its href, so a design link survives into the brief. */
function linked(n: Node): string {
	const text = n.text ?? "";
	const href = n.marks?.find((m) => m.type === "link")?.attrs?.href;
	return typeof href === "string" && href && href !== text
		? `${text} (${href})`
		: text;
}

export function adfToText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const n = node as Node;
	const inner = (n.content ?? []).map(adfToText).join("");
	switch (n.type) {
		case "text":
			return linked(n);
		case "hardBreak":
			return "\n";
		case "codeBlock":
			return `\n${FENCE}${String(n.attrs?.language ?? "")}\n${inner}\n${FENCE}\n`;
		case "paragraph":
		case "heading":
			return `${inner}\n`;
		case "listItem":
			return `- ${inner}`;
		case "inlineCard":
			return String(n.attrs?.url ?? "");
		case "blockCard":
		case "embedCard":
			return `${String(n.attrs?.url ?? "")}\n`;
		default:
			return inner;
	}
}

const PLAN_LANGUAGES = new Set(["plan", "portia"]);

/** The ADF `doc` with every plan codeBlock replaced by one, holding `block`, at the end. */
export function withPlanBlockAdf(doc: unknown, block: string): unknown {
	const d = (doc && typeof doc === "object" ? doc : {}) as Node & {
		version?: number;
	};
	const kept = (d.content ?? []).filter((n) => {
		const c = n as Node;
		return !(
			c.type === "codeBlock" && PLAN_LANGUAGES.has(String(c.attrs?.language))
		);
	});
	return {
		...d,
		type: "doc",
		version: d.version ?? 1,
		content: [
			...kept,
			{
				type: "codeBlock",
				attrs: { language: "plan" },
				content: [{ type: "text", text: block.trimEnd() }],
			},
		],
	};
}
