import { describe, expect, it } from "bun:test";
import { launched, paidOrder, priced, startShop } from "./_shop";

const shop = startShop();

describe("R8: rocket telemetry becomes live tracking", () => {
	it("shows the latest point, then lands at altitude zero", async () => {
		const { order } = await paidOrder(shop, [{ productId: "anvil" }]);
		const l = await launched(shop, order.id, "Red Mesa");
		const p1 = {
			lat: 35.1,
			lng: -111.2,
			altitudeFt: 12000,
			at: "2026-10-20T13:59:00.000Z",
		};
		const p2 = {
			lat: 35.2,
			lng: -111.1,
			altitudeFt: 6000,
			at: "2026-10-20T13:59:30.000Z",
		};
		expect((await shop.post(`/deliveries/${l.id}/telemetry`, p1)).status).toBe(
			202,
		);
		expect((await shop.post(`/deliveries/${l.id}/telemetry`, p2)).status).toBe(
			202,
		);
		let t = await shop.get(`/deliveries/${l.id}/tracking`);
		expect(t.status).toBe(200);
		expect(t.data.points).toBe(2);
		expect(t.data.position).toEqual(p2);
		expect(t.data.landed).toBe(false);
		expect(t.data.status).toBe("launched");
		const down = {
			lat: 35.3,
			lng: -111.0,
			altitudeFt: 0,
			at: "2026-10-20T14:00:00.000Z",
		};
		await shop.post(`/deliveries/${l.id}/telemetry`, down);
		t = await shop.get(`/deliveries/${l.id}/tracking`);
		expect(t.data.landed).toBe(true);
		expect(t.data.status).toBe("landed");
		expect((await shop.get(`/deliveries/${l.id}`)).data.landedAt).toBe(down.at);
	});
	it("takes no telemetry before launch, and needs every field", async () => {
		const { order } = await paidOrder(shop, [{ productId: "anvil" }]);
		const p = await priced(shop, order.id);
		const point = {
			lat: 1,
			lng: 2,
			altitudeFt: 3,
			at: "2026-10-20T14:00:00.000Z",
		};
		expect(
			(await shop.post(`/deliveries/${p.id}/telemetry`, point)).status,
		).toBe(409);
		const l = await launched(
			shop,
			(await paidOrder(shop, [{ productId: "anvil" }])).order.id,
		);
		expect(
			(await shop.post(`/deliveries/${l.id}/telemetry`, { lat: 1 })).status,
		).toBe(400);
	});
});
