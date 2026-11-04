# Turn rocket telemetry into live tracking

Part of ACME-500: Rocket delivery to remote mesas.

**Scenario R8**: rocket telemetry becomes live tracking

**Paths**: `src/tracking/**`, `specs/tracking/**`

**Needs**: ACME-506 (launch a delivery and telegram the customer)

A launched rocket reports its position. The shop keeps the readings and shows the customer
where their crates are, until touchdown.

## Behaviour

`POST /deliveries/:id/telemetry` with `{ "lat": 36.06, "lng": -112.14, "altitudeFt": 8200, "at": "2026-11-02T09:15:00.000Z" }`

- `202` when accepted. Every field is required: `lat`, `lng` and `altitudeFt` numbers, `at`
  an ISO 8601 time; `400` otherwise.
- Only a `launched` delivery takes telemetry: `409` before launch and after landing or a
  miss. `404` for an unknown delivery.
- A reading at `altitudeFt` 0 is touchdown: the delivery becomes `status: "landed"` with
  `landedAt` set to that reading's `at`.

`GET /deliveries/:id/tracking`: `200` with
`{ deliveryId, status, points, position, landed }`:

- `points`: how many readings the delivery has sent;
- `position`: the latest reading by `at`, exactly `{ lat, lng, altitudeFt, at }`, or `null`
  before the first;
- `landed`: `true` once it has touched down;
- `404` for an unknown delivery.

## Done when

- R8 holds, proved by specs under `specs/tracking/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
