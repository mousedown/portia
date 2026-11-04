import { describe, expect, it } from "bun:test";
import { paidOrder, priced, startShop } from "./_shop";

const shop = startShop();

describe("R3: a canyon surcharge follows the delivery county", () => {
	it("adds the county's percentage to the zone price", async () => {
		const { order } = await paidOrder(
			shop,
			[{ productId: "anvil" }],
			"Canyon Diablo",
		);
		const p = await priced(shop, order.id, "Red Mesa"); // 2500, +25%
		expect(p.priceCents).toBe(2500);
		expect(p.surchargeCents).toBe(625);
		expect(p.totalCents).toBe(3125);
	});
	it("charges nothing where no rule applies", async () => {
		const { order } = await paidOrder(shop, [{ productId: "anvil" }], "Mesa");
		const p = await priced(shop, order.id, "Grand Mesa"); // 4500
		expect(p.surchargeCents).toBe(0);
		expect(p.totalCents).toBe(4500);
	});
});
