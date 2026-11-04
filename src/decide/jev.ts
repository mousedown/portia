import { PortiaProblem } from "../core/exit";
import type { DecideInput, DecisionKind, JevClient } from "./decide";

// The request/response shape is an assumption about Jev, kept in this file only.
export function httpJev(
	url: string,
	key: string,
	fetchFn: typeof fetch = fetch,
): JevClient {
	return {
		async ask(kind: DecisionKind, input: DecideInput) {
			const res = await fetchFn(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ kind, input }),
			});
			if (!res.ok) throw new PortiaProblem(`Jev returned ${res.status}`);
			return (await res.json()) as { answer: string; why: string };
		},
	};
}

export const jevFromProfile = (p: {
	jev: { enabled: boolean; url?: string };
}) =>
	p.jev.enabled && p.jev.url && process.env.JEV_API_KEY
		? httpJev(p.jev.url, process.env.JEV_API_KEY)
		: undefined;
