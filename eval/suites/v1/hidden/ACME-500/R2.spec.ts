import { describe, expect, it } from "bun:test";
import { delivery, paidOrder, priced, startShop } from "./_shop";

const shop = startShop();

describe("R2: a delivery is priced from the mesa zone table", () => {
	it("charges the zone rate per started 100 lb", async () => {
		const a = await paidOrder(shop, [{ productId: "anvil" }]); // 500 lb
		const p = await priced(shop, a.order.id, "Red Mesa"); // zone A, 500 per 100 lb
		expect(p.priceCents).toBe(2500);
		expect(p.status).toBe("priced");
		const b = await paidOrder(shop, [
			{ productId: "dehydrated-boulders", qty: 3 },
		]); // 120 lb
		const q = await priced(shop, b.order.id, "Monument Mesa"); // zone C, 1500
		expect(q.priceCents).toBe(2 * 1500);
		const got = await shop.get(`/deliveries/${q.id}`);
		expect(got.data.zone).toBe("C");
		expect(got.data.priceCents).toBe(3000);
	});
	it("refuses a mesa with no zone", async () => {
		const { order } = await paidOrder(shop, [{ productId: "anvil" }]);
		const d = await delivery(shop, order.id, "Nowhere Mesa");
		const r = await shop.post(`/deliveries/${d.id}/price`);
		expect(r.status).toBe(422);
		expect(r.data.error).toBe("no zone for mesa");
	});
});
