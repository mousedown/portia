# Show a customer every order they have placed

Part of ACME-400: Rocket delivery quotes and order history.

**Scenario R4**: a customer sees every order they have placed

**Paths**: `src/orders/**`, `specs/orders/**`

**Needs**: ACME-401 (manifest a paid order as a rocket delivery)

A customer can see their order history, with the rocket delivery of each order where one
exists.

## Behaviour

`GET /customers/:id/orders`

- `200` with an array of every order the customer has placed, **newest first** (by
  `placedAt`), paid or not. Each entry is the order as `GET /orders/:id` returns it, plus
  `delivery`.
- `delivery` is `null` when the order has none, otherwise
  `{ id, status, mesa, totalCents }` of its delivery (`totalCents` is `null` until the
  delivery is priced).
- Another customer's orders never appear.
- `200` with `[]` for a customer with no orders; `404` for an unknown customer.

## Done when

- R4 holds, proved by specs under `specs/orders/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
