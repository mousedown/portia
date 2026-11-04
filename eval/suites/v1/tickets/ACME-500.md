# Rocket delivery to remote mesas

Customers on the remote mesas can't get ACME goods by road. This feature sends a paid order
by rocket: the shop manifests the crates, prices the flight from the mesa's zone and the
customer's county, launches it, tracks it to touchdown, and refunds it if it misses. The
customer can see every order they have placed, download a signed receipt, and gets a
telegram when the rocket is airborne.

## Scenarios

The feature is done when every one of these holds, each proved by tests:

- **R1**: a delivery order lists every crate on the manifest
- **R2**: a delivery is priced from the mesa zone table
- **R3**: a canyon surcharge follows the delivery county
- **R4**: a customer sees every order they have placed
- **R5**: a customer downloads a signed receipt as PDF
- **R6**: the customer gets a telegram when the rocket is airborne
- **R7**: an order that misses its target is refunded
- **R8**: rocket telemetry becomes live tracking

## Tickets

| Ticket | Scenario | Paths |
| --- | --- | --- |
| ACME-501 Manifest a paid order as a rocket delivery | R1 | `src/delivery/**`, `specs/delivery/**` |
| ACME-502 Price a delivery from the mesa zone table | R2 | `src/pricing/**`, `specs/pricing/**` |
| ACME-503 Add the canyon surcharge by delivery county | R3 | `src/surcharge/**`, `specs/surcharge/**` |
| ACME-504 Show a customer every order they have placed | R4 | `src/orders/**`, `specs/orders/**` |
| ACME-505 Download a signed PDF receipt for a delivery | R5 | `src/receipt/**`, `specs/receipt/**` |
| ACME-506 Launch a delivery and telegram the customer | R6 | `src/launch/**`, `specs/launch/**` |
| ACME-507 Refund an order whose rocket misses its target | R7 | `src/refunds/**`, `specs/refunds/**` |
| ACME-508 Turn rocket telemetry into live tracking | R8 | `src/tracking/**`, `specs/tracking/**` |

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
