import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { delivery, paidOrder, priced, startShop } from "./_shop";

const shop = startShop();

describe("R5: a customer downloads a signed receipt as PDF", () => {
	it("is a PDF naming the delivery, its crates and the total, signed over its bytes", async () => {
		const { order } = await paidOrder(shop, [
			{ productId: "rocket-skates", qty: 2 },
		]);
		const d = await priced(shop, order.id, "Grand Mesa");
		const r = await shop.get(`/deliveries/${d.id}/receipt`);
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toStartWith("application/pdf");
		const text = new TextDecoder("latin1").decode(r.bytes);
		expect(text.startsWith("%PDF-")).toBe(true);
		expect(text).toContain(d.id);
		expect(text).toContain("rocket-skates");
		expect(text).toContain(String(d.totalCents));
		const sig = createHmac("sha256", "hidden-spec-key")
			.update(r.bytes)
			.digest("hex");
		expect(r.headers.get("x-acme-signature")).toBe(sig);
	});
	it("refuses an unpriced delivery and an unknown one", async () => {
		const { order } = await paidOrder(shop, [{ productId: "anvil" }]);
		const d = await delivery(shop, order.id);
		expect((await shop.get(`/deliveries/${d.id}/receipt`)).status).toBe(409);
		expect((await shop.get("/deliveries/nothing/receipt")).status).toBe(404);
	});
});
