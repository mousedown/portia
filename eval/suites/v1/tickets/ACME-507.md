# Refund an order whose rocket misses its target

Part of ACME-500: Rocket delivery to remote mesas.

**Scenario R7**: an order that misses its target is refunded

**Paths**: `src/refunds/**`, `specs/refunds/**`

**Needs**: ACME-506 (launch a delivery and telegram the customer)

Sometimes the rocket misses. The delivery is then marked missed and the customer is refunded
for the goods and the delivery together.

## Behaviour

`POST /deliveries/:id/missed`

- For a `launched` delivery: `status: "missed"`, and in the same transaction:
  - one refund on the order: `{ id, orderId, deliveryId, amountCents, reason, refundedAt }`
    with `amountCents` = the order's `subtotalCents` + the delivery's `totalCents`, and
    `reason: "missed target"`;
  - the order's status becomes `refunded` (a new order status after `paid`).
- `200` with the delivery.
- `409` when the delivery is not `launched` (including when it is already missed, so an
  order is refunded once); `404` for an unknown delivery.

`GET /orders/:id/refunds`: `200` with the order's refunds; `404` for an unknown order.

## Example

Customer in Kaibab, one safe (subtotal 24999, 800 lb) to Table Mesa: delivery 4000 + 20% =
4800. Missed -> one refund of 29799, reason "missed target", order `refunded`.

## Done when

- R7 holds, proved by specs under `specs/refunds/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
