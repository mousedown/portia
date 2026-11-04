# Launch a delivery and telegram the customer

Part of ACME-500: Rocket delivery to remote mesas.

**Scenario R6**: the customer gets a telegram when the rocket is airborne

**Paths**: `src/launch/**`, `specs/launch/**`

**Needs**: ACME-502 (price a delivery from the mesa zone table)

When the rocket leaves, the delivery is launched and the customer gets a telegram saying it
is airborne.

## Behaviour

`POST /deliveries/:id/launch`

- Launches a `priced` delivery: `status: "launched"`, `launchedAt` set to now (ISO 8601).
  `200` with the delivery.
- Records one telegram to the order's customer, in the same transaction:
  `{ id, customerId, deliveryId, text, sentAt }`. The `text` contains the word "airborne"
  (any case) and the mesa's name exactly as the delivery has it, e.g.
  `ACME ROCKET AIRBORNE STOP YOUR CRATES ARE BOUND FOR Black Mesa STOP`.
- `409` when the delivery is not `priced` (not yet priced, or already launched: a delivery
  launches once and the customer gets one telegram); `404` for an unknown delivery.

`GET /customers/:id/telegrams`: `200` with the customer's telegrams, oldest first; `404` for
an unknown customer.

## Done when

- R6 holds, proved by specs under `specs/launch/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
