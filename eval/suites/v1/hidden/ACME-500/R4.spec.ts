import { describe, expect, it } from "bun:test";
import { priced, startShop } from "./_shop";

const shop = startShop();

describe("R4: a customer sees every order they have placed", () => {
	it("lists orders newest first with their delivery, when one exists", async () => {
		const c = await shop.post("/customers", {
			name: "W. E. Coyote",
			county: "Mesa",
		});
		const first = await shop.post("/orders", {
			customerId: c.data.id,
			items: [{ productId: "anvil" }],
		});
		await shop.post(`/orders/${first.data.id}/pay`);
		const d = await priced(shop, first.data.id as string, "Black Mesa");
		await Bun.sleep(5);
		const second = await shop.post("/orders", {
			customerId: c.data.id,
			items: [{ productId: "bird-seed" }],
		});
		const r = await shop.get(`/customers/${c.data.id}/orders`);
		expect(r.status).toBe(200);
		const orders = r.data as unknown as {
			id: string;
			delivery: null | {
				id: string;
				status: string;
				mesa: string;
				totalCents: number | null;
			};
		}[];
		expect(orders.map((o) => o.id)).toEqual([second.data.id, first.data.id]);
		expect(orders[0]?.delivery).toBeNull();
		expect(orders[1]?.delivery?.id).toBe(d.id);
		expect(orders[1]?.delivery?.mesa).toBe("Black Mesa");
		expect(orders[1]?.delivery?.totalCents).toBe(d.totalCents);
	});
	it("is 404 for an unknown customer", async () => {
		expect((await shop.get("/customers/nobody/orders")).status).toBe(404);
	});
});
