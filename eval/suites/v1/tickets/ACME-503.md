# Add the canyon surcharge by delivery county

Part of ACME-500: Rocket delivery to remote mesas.

**Scenario R3**: a canyon surcharge follows the delivery county

**Paths**: `src/surcharge/**`, `specs/surcharge/**`

**Needs**: ACME-502 (price a delivery from the mesa zone table)

Deliveries into canyon country cost more: the customer's county (given when they registered,
`customer.county`) decides a percentage added on top of the zone price.

## Surcharge rules

| County | Surcharge |
| --- | --- |
| Canyon Diablo | 25% |
| Kaibab | 20% |
| Coconino | 10% |

Any other county has no surcharge. The surcharge is the zone price times the percentage,
rounded to the nearest cent.

## Behaviour

When a delivery is priced (`POST /deliveries/:id/price`):

- `surchargeCents` is the county's surcharge on `priceCents`, and `totalCents` is
  `priceCents + surchargeCents`.
- `priceCents` stays the zone price alone.

## Examples

- Customer in Kaibab, one anvil (500 lb) to Black Mesa (zone B): price 4500, surcharge 900,
  total 5400.
- Customer in Coconino, one giant magnet (250 lb) to Monument Mesa (zone C): price 4500,
  surcharge 450, total 4950.
- Customer in Apache county, anything anywhere: surcharge 0.

## Done when

- R3 holds, proved by specs under `specs/surcharge/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
