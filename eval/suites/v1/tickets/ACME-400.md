# Rocket delivery quotes and order history

The first half of rocket delivery to the remote mesas: the shop manifests a paid order's
crates as a rocket delivery and quotes the flight from the mesa's zone and the customer's
county, and a customer can see every order they have placed with its delivery. Launch,
receipts, refunds and tracking come later.

## Scenarios

The feature is done when every one of these holds, each proved by tests:

- **R1**: a delivery order lists every crate on the manifest
- **R2**: a delivery is priced from the mesa zone table
- **R3**: a canyon surcharge follows the delivery county
- **R4**: a customer sees every order they have placed

## Tickets

| Ticket | Scenario | Paths |
| --- | --- | --- |
| ACME-401 Manifest a paid order as a rocket delivery | R1 | `src/delivery/**`, `specs/delivery/**` |
| ACME-402 Price a delivery from the mesa zone table | R2 | `src/pricing/**`, `specs/pricing/**` |
| ACME-403 Add the canyon surcharge by delivery county | R3 | `src/surcharge/**`, `specs/surcharge/**` |
| ACME-404 Show a customer every order they have placed | R4 | `src/orders/**`, `specs/orders/**` |

## Shared contract

Every child builds on one delivery record, owned by the delivery ticket:

- One delivery per paid order, at `/deliveries/:id`, with
  `id, orderId, mesa, status, crates[{ productId, qty, weightLb }], totalWeightLb, zone,
  priceCents, surchargeCents, totalCents, createdAt, launchedAt, landedAt`. Fields a later
  stage fills are `null` until then, and `GET /deliveries/:id` always returns every field.
- Its status moves `manifested` -> `priced` -> `launched` -> `landed` or `missed`, never
  backwards. An action on a delivery in the wrong status is `409`.
- Money in integer cents, weight in pounds, times as ISO 8601 strings, errors as
  `{ "error": "..." }`, as everywhere in the shop (see CLAUDE.md).
- Each child is its own feature folder under `src/` (with its specs under `specs/`), picked
  up by the app without editing the server.
