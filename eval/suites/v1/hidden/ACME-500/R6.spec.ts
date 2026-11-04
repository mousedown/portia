import { describe, expect, it } from "bun:test";
import { delivery, launched, paidOrder, startShop } from "./_shop";

const shop = startShop();

describe("R6: the customer gets a telegram when the rocket is airborne", () => {
	it("records one telegram at launch naming the mesa", async () => {
		const { customer, order } = await paidOrder(shop, [{ productId: "anvil" }]);
		const l = await launched(shop, order.id, "Black Mesa");
		expect(l.status).toBe("launched");
		expect(typeof l.launchedAt).toBe("string");
		const t = await shop.get(`/customers/${customer.id}/telegrams`);
		expect(t.status).toBe(200);
		const telegrams = t.data as unknown as {
			deliveryId: string;
			text: string;
			sentAt: string;
		}[];
		expect(telegrams).toHaveLength(1);
		expect(telegrams[0]?.deliveryId).toBe(l.id);
		expect(telegrams[0]?.text.toLowerCase()).toContain("airborne");
		expect(telegrams[0]?.text).toContain("Black Mesa");
	});
	it("only launches a priced delivery", async () => {
		const { order } = await paidOrder(shop, [{ productId: "anvil" }]);
		const d = await delivery(shop, order.id);
		expect((await shop.post(`/deliveries/${d.id}/launch`)).status).toBe(409);
	});
});
