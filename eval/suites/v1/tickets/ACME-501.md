# Manifest a paid order as a rocket delivery

Part of ACME-500: Rocket delivery to remote mesas.

**Scenario R1**: a delivery order lists every crate on the manifest

**Paths**: `src/delivery/**`, `specs/delivery/**`

A paid order can be sent by rocket to a mesa. Creating the delivery writes its manifest: one
crate per order item, weighed from the catalogue.

This ticket also owns the **delivery record** the rest of the epic builds on (see the epic's
shared contract): its table, its `Delivery` type with every field later tickets fill
(`zone`, `priceCents`, `surchargeCents`, `totalCents`, `launchedAt`, `landedAt`, all `null`
until set), and the repository functions other features use to read a delivery and move it
through its statuses.

## Behaviour

`POST /orders/:id/deliveries` with `{ "mesa": "Red Mesa" }`

- `201` with the delivery: `id`, `orderId`, `mesa`, `status: "manifested"`, `crates`,
  `totalWeightLb`, and the later fields as `null`.
- `crates` has one entry per order item, in order: `{ productId, qty, weightLb }`, where
  `weightLb` is the product's catalogue weight times `qty` (two anvils at 500 lb are one
  1000 lb crate). `totalWeightLb` is the sum of the crates.
- Any mesa name is accepted here; whether ACME's rockets reach it is decided when the
  delivery is priced.
- `400` without a `mesa`; `404` for an unknown order; `409` when the order is not paid, or
  already has a delivery (one delivery per order).

`GET /deliveries/:id`: `200` with the delivery as it now is, every field included; `404` for
an unknown id.

## Example

Order: 2 x `anvil` (500 lb each), 4 x `tornado-seeds` (1 lb each) ->
crates `anvil` qty 2 at 1000 lb and `tornado-seeds` qty 4 at 4 lb; `totalWeightLb` 1004.

## Done when

- R1 holds, proved by specs under `specs/delivery/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
