# Price a delivery from the mesa zone table

Part of ACME-500: Rocket delivery to remote mesas.

**Scenario R2**: a delivery is priced from the mesa zone table

**Paths**: `src/pricing/**`, `specs/pricing/**`

**Needs**: ACME-501 (manifest a paid order as a rocket delivery)

Each mesa ACME's rockets reach is in a zone, and each zone has a rate per started 100 lb.

## Zone table

| Mesa | Zone |
| --- | --- |
| Red Mesa | A |
| Table Mesa | A |
| Black Mesa | B |
| Grand Mesa | B |
| Monument Mesa | C |

| Zone | Rate per started 100 lb |
| --- | --- |
| A | 500 cents |
| B | 900 cents |
| C | 1500 cents |

"Per started 100 lb": the weight is rounded **up** to the next whole 100 lb. 500 lb in zone A
is 5 x 500 = 2500 cents; 250 lb in zone B is 3 x 900 = 2700 cents; 101 lb is two units.

## Behaviour

`POST /deliveries/:id/price`

- Prices a `manifested` delivery: sets `zone`, `priceCents` (the zone price),
  `surchargeCents` and `totalCents` (`priceCents + surchargeCents`), and moves it to
  `status: "priced"`. `200` with the delivery.
- The surcharge comes from the canyon surcharge rules (the surcharge ticket); with no rule
  for the customer's county it is `0`.
- `422` with `{ "error": "no zone for mesa" }` when the mesa is not in the zone table.
- `404` for an unknown delivery; `409` when it is not `manifested` (already priced, or
  further along).

`GET /deliveries/:id` then shows `zone`, `priceCents`, `surchargeCents` and `totalCents`.

## Done when

- R2 holds, proved by specs under `specs/pricing/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
