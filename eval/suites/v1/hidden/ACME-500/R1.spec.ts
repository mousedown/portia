import { describe, expect, it } from "bun:test";
import { delivery, paidOrder, startShop } from "./_shop";

const shop = startShop();

describe("R1: a delivery order lists every crate on the manifest", () => {
	it("makes one crate per order item, weighed from the catalogue", async () => {
		const { order } = await paidOrder(shop, [
			{ productId: "anvil", qty: 2 },
			{ productId: "bird-seed", qty: 3 },
		]);
		const d = await delivery(shop, order.id, "Red Mesa");
		expect(d.crates).toHaveLength(2);
		const anvil = d.crates.find((c) => c.productId === "anvil");
		const seed = d.crates.find((c) => c.productId === "bird-seed");
		expect(anvil?.qty).toBe(2);
		expect(anvil?.weightLb).toBe(1000);
		expect(seed?.qty).toBe(3);
		expect(seed?.weightLb).toBe(150);
		expect(d.totalWeightLb).toBe(1150);
		const got = await shop.get(`/deliveries/${d.id}`);
		expect(got.status).toBe(200);
		expect((got.data.crates as unknown[]).length).toBe(2);
		expect(got.data.status).toBe("manifested");
		expect(got.data.mesa).toBe("Red Mesa");
	});
	it("refuses an unpaid order and a second delivery", async () => {
		const c = await shop.post("/customers", {
			name: "W. E. Coyote",
			county: "Mesa",
		});
		const o = await shop.post("/orders", {
			customerId: c.data.id,
			items: [{ productId: "safe" }],
		});
		expect(
			(await shop.post(`/orders/${o.data.id}/deliveries`, { mesa: "Red Mesa" }))
				.status,
		).toBe(409);
		const { order } = await paidOrder(shop, [{ productId: "safe" }]);
		await delivery(shop, order.id);
		expect(
			(await shop.post(`/orders/${order.id}/deliveries`, { mesa: "Red Mesa" }))
				.status,
		).toBe(409);
	});
});
