import { describe, expect, it } from "bun:test";
import { launched, paidOrder, priced, startShop } from "./_shop";

const shop = startShop();

describe("R7: an order that misses its target is refunded", () => {
	it("refunds the order and the delivery together, once", async () => {
		const { order } = await paidOrder(
			shop,
			[{ productId: "anvil", qty: 2 }],
			"Coconino",
		);
		const l = await launched(shop, order.id, "Red Mesa"); // 5000 + 10% = 5500
		const m = await shop.post(`/deliveries/${l.id}/missed`);
		expect(m.status).toBe(200);
		expect(m.data.status).toBe("missed");
		const refunds = await shop.get(`/orders/${order.id}/refunds`);
		expect(refunds.status).toBe(200);
		const list = refunds.data as unknown as {
			amountCents: number;
			reason: string;
		}[];
		expect(list).toHaveLength(1);
		expect(list[0]?.amountCents).toBe(order.subtotalCents + l.totalCents);
		expect(list[0]?.reason).toBe("missed target");
		expect((await shop.get(`/orders/${order.id}`)).data.status).toBe(
			"refunded",
		);
		expect((await shop.post(`/deliveries/${l.id}/missed`)).status).toBe(409);
	});
	it("needs a launched delivery", async () => {
		const { order } = await paidOrder(shop, [{ productId: "anvil" }]);
		const p = await priced(shop, order.id);
		expect((await shop.post(`/deliveries/${p.id}/missed`)).status).toBe(409);
	});
});
