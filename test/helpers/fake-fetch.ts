export interface Call {
	url: string;
	method: string;
	body?: unknown;
}
export function fakeFetch(
	routes: Record<string, unknown>,
	calls: Call[] = [],
): typeof fetch {
	return (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		calls.push({
			url: u,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const hit = Object.entries(routes).find(([k]) => u.includes(k));
		if (!hit) return new Response("not found", { status: 404 });
		return hit[1] === null
			? new Response(null, { status: 204 })
			: new Response(JSON.stringify(hit[1]), { status: 200 });
	}) as typeof fetch;
}
