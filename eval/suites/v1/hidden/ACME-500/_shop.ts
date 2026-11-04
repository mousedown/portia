/**
 * Shared by the hidden specs, and copied in beside them: starts the shop under test from
 * its own `src/server.ts` on a free port with an in-memory database, and talks HTTP to it.
 * Nothing here imports the repository's code, so a renamed helper cannot break the score.
 */
import { afterAll, beforeAll } from "bun:test";

export interface Shop {
	get: (p: string, init?: RequestInit) => Promise<Res>;
	post: (p: string, body?: unknown) => Promise<Res>;
	url: string;
}
export interface Res {
	status: number;
	headers: Headers;
	data: Record<string, unknown> & Record<number, unknown>;
	bytes: Uint8Array;
}

export function startShop(): Shop {
	const port = 4000 + Math.floor(Math.random() * 20000);
	const url = `http://127.0.0.1:${port}`;
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	beforeAll(async () => {
		proc = Bun.spawn(["bun", "src/server.ts"], {
			env: {
				...process.env,
				PORT: String(port),
				DATABASE_PATH: ":memory:",
				ACME_SIGNING_KEY: "hidden-spec-key",
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${url}/health`)).ok) return;
			} catch {
				// not up yet
			}
			await Bun.sleep(100);
		}
		throw new Error(`shop did not start on ${url}`);
	});
	afterAll(() => proc?.kill());
	const call = async (
		method: string,
		p: string,
		body?: unknown,
		init: RequestInit = {},
	) => {
		const res = await fetch(`${url}${p}`, {
			method,
			headers:
				body === undefined
					? init.headers
					: { "content-type": "application/json", ...init.headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const bytes = new Uint8Array(await res.arrayBuffer());
		let data: unknown = {};
		try {
			data = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			// not JSON: the bytes are the answer
		}
		return {
			status: res.status,
			headers: res.headers,
			data: data as Res["data"],
			bytes,
		};
	};
	return {
		url,
		get: (p, init) => call("GET", p, undefined, init),
		post: (p, body) => call("POST", p, body),
	};
}

/** A paid order of the given items for a new customer in `county`, ready to be delivered. */
export async function paidOrder(
	shop: Shop,
	items: { productId: string; qty?: number }[],
	county = "Mesa",
) {
	const c = await shop.post("/customers", { name: "W. E. Coyote", county });
	if (c.status !== 201) throw new Error(`customer: ${c.status}`);
	const o = await shop.post("/orders", { customerId: c.data.id, items });
	if (o.status !== 201) throw new Error(`order: ${o.status}`);
	const paid = await shop.post(`/orders/${o.data.id}/pay`);
	if (paid.status !== 200) throw new Error(`pay: ${paid.status}`);
	return {
		customer: c.data as { id: string },
		order: paid.data as { id: string; subtotalCents: number },
	};
}

export async function delivery(shop: Shop, orderId: string, mesa = "Red Mesa") {
	const d = await shop.post(`/orders/${orderId}/deliveries`, { mesa });
	if (d.status !== 201)
		throw new Error(`delivery: ${d.status} ${JSON.stringify(d.data)}`);
	return d.data as {
		id: string;
		crates: { productId: string; qty: number; weightLb: number }[];
		totalWeightLb: number;
	};
}

export async function priced(shop: Shop, orderId: string, mesa = "Red Mesa") {
	const d = await delivery(shop, orderId, mesa);
	const p = await shop.post(`/deliveries/${d.id}/price`);
	if (p.status !== 200)
		throw new Error(`price: ${p.status} ${JSON.stringify(p.data)}`);
	return p.data as {
		id: string;
		priceCents: number;
		surchargeCents: number;
		totalCents: number;
		mesa: string;
		status: string;
	};
}

export async function launched(shop: Shop, orderId: string, mesa = "Red Mesa") {
	const d = await priced(shop, orderId, mesa);
	const l = await shop.post(`/deliveries/${d.id}/launch`);
	if (l.status !== 200)
		throw new Error(`launch: ${l.status} ${JSON.stringify(l.data)}`);
	return l.data as typeof d & { launchedAt: string };
}
