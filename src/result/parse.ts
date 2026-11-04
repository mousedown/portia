import { z } from "zod";
import type { WorkerResult } from "../core/types";

const Gate = z.enum(["pass", "fail"]);
export const ResultSchema = z
	.object({
		child: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
		status: z.enum(["done", "parked", "failed"]),
		head: z.string().regex(/^[0-9a-f]{7,40}$/),
		gates: z.object({ task: Gate, exit: Gate }),
		evidence: z.record(z.string(), z.string()),
		question: z.string().min(1).optional(),
		reason: z.string().min(1).optional(),
		spec: z
			.object({
				path: z.string().min(1),
				assertion: z.string().min(1),
				evidence: z.string().min(1),
			})
			.strict()
			.optional(),
	})
	.strict()
	.refine((r) => r.status !== "parked" || !!r.question || !!r.spec, {
		message: "a parked result needs a question",
	})
	.refine((r) => r.status !== "done" || !r.spec, {
		message: "a done result names no spec that cannot pass",
	})
	.refine((r) => r.status !== "failed" || !!r.reason, {
		message: "a failed result needs a reason",
	})
	.refine(
		(r) =>
			r.status !== "done" ||
			(r.gates.task === "pass" && r.gates.exit === "pass"),
		{ message: "a done result needs both gates passing" },
	);

export type ParseOutcome =
	| { ok: true; result: WorkerResult }
	| { ok: false; error: string };
const FENCED = /^`{3}(?:json)?[ \t]*\n([\s\S]*)\n`{3}$/;

export function parseResult(text: string, expectedChild: string): ParseOutcome {
	const trimmed = text.trim();
	const body = (FENCED.exec(trimmed)?.[1] ?? trimmed).trim();
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return {
			ok: false,
			error: "the worker's last message is not exactly one JSON object",
		};
	}
	const parsed = ResultSchema.safeParse(raw);
	if (!parsed.success)
		return {
			ok: false,
			error: parsed.error.issues.map((i) => i.message).join("; "),
		};
	if (parsed.data.child !== expectedChild)
		return {
			ok: false,
			error: `the result is for ${parsed.data.child}, expected ${expectedChild}`,
		};
	return { ok: true, result: parsed.data };
}
