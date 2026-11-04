import picomatch from "picomatch";
import { accountsOf, allLimited } from "../core/accounts";
import type { Profile } from "../core/config";
import { appendRow } from "../core/runlog";
import { isUsageLimit, NOT_LOGGED_IN } from "../worker/usage-limit";

export type DecisionKind = "failure" | "park-answerable" | "touches-mismatch";
export interface DecideInput {
	child: string;
	touches: string[];
	failure?: { reason: string; attempts: number };
	park?: { question: string; ticket: string };
	outside?: string[];
	/** Globs the person approved outside this child's touches (`portia touches allow`). */
	approved?: string[];
}
export interface Decision {
	kind: DecisionKind;
	answer: string;
	by: "rule" | "jev";
	why: string;
}
export interface JevClient {
	ask(
		kind: DecisionKind,
		input: DecideInput,
	): Promise<{ answer: string; why: string }>;
}

const ALLOWED: Record<DecisionKind, string[]> = {
	failure: ["retry", "park"],
	"park-answerable": ["answered", "ask-human"],
	"touches-mismatch": ["accept", "park"],
};
const FALLBACK: Record<DecisionKind, string> = {
	failure: "park",
	"park-answerable": "ask-human",
	"touches-mismatch": "park",
};
const NEVER_RETRY = /permission|denied|secret|credential|EACCES/i;
const literal = (g: string) => g.replace(/\*\*/g, "x/x").replace(/\*/g, "x");

function rule(
	kind: DecisionKind,
	input: DecideInput,
	p: Profile,
): Omit<Decision, "kind" | "by"> | null {
	if (kind === "failure" && input.failure) {
		const f = input.failure;
		const loggedOut = f.reason.startsWith(NOT_LOGGED_IN);
		if (isUsageLimit(f.reason) || loggedOut) {
			const limited = allLimited(accountsOf(p.workers));
			return limited
				? { answer: "park", why: limited }
				: {
						answer: "retry",
						why: loggedOut
							? "the worker's account is not logged in; another account takes the retry, which spends none"
							: "the worker's account hit its usage limit; another account takes the retry, which spends none",
					};
		}
		if (NEVER_RETRY.test(f.reason))
			return {
				answer: "park",
				why: "the failure mentions permissions or secrets; a retry will not fix it",
			};
		return f.attempts <= p.maxRetries
			? { answer: "retry", why: `attempt ${f.attempts} of ${p.maxRetries + 1}` }
			: { answer: "park", why: `all ${p.maxRetries + 1} attempts used` };
	}
	if (kind === "touches-mismatch" && input.outside) {
		const incidental = picomatch(p.allowedIncidental, { dot: true });
		const approved = input.approved?.length
			? picomatch(input.approved, { dot: true })
			: () => false;
		if (input.outside.every((f) => incidental(f)))
			return {
				answer: "accept",
				why: "only incidental files changed outside touches",
			};
		if (input.outside.every((f) => incidental(f) || approved(f)))
			return {
				answer: "accept",
				why: "every file outside touches is incidental or approved for this child",
			};
	}
	return null;
}

const sensitive = (input: DecideInput, p: Profile) => {
	const m = picomatch(p.sensitiveGlobs, { dot: true });
	return (
		input.touches.some((t) => t.includes("**") || m(literal(t))) ||
		(input.outside ?? []).some((f) => m(f))
	);
};

export async function decide(
	kind: DecisionKind,
	input: DecideInput,
	ctx: { profile: Profile; dir: string; jev?: JevClient },
): Promise<Decision> {
	const p = ctx.profile;
	const r = rule(kind, input, p);
	let d: Decision;
	if (r) d = { kind, by: "rule", ...r };
	else if (sensitive(input, p))
		d = {
			kind,
			by: "rule",
			answer: FALLBACK[kind],
			why: "the child touches sensitive code, so Jev is never asked (N6)",
		};
	else if (p.jev.enabled && ctx.jev) {
		const fallback = (why: string): Decision => ({
			kind,
			by: "rule",
			answer: FALLBACK[kind],
			why,
		});
		try {
			const j = await ctx.jev.ask(kind, input);
			if (!j || typeof j !== "object" || typeof j.answer !== "string")
				d = fallback("Jev returned a malformed response");
			else
				d = ALLOWED[kind].includes(j.answer)
					? { kind, by: "jev", answer: j.answer, why: String(j.why) }
					: fallback(
							`Jev answered '${j.answer}', which is not an allowed answer`,
						);
		} catch (e) {
			d = fallback(`Jev failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	} else
		d = {
			kind,
			by: "rule",
			answer: FALLBACK[kind],
			why: "no rule answered and Jev is off",
		};
	appendRow(ctx.dir, {
		child: input.child,
		attempt: 0,
		stage: "decision",
		status: d.answer,
		data: { ...d },
	});
	return d;
}
