# Download a signed PDF receipt for a delivery

Part of ACME-500: Rocket delivery to remote mesas.

**Scenario R5**: a customer downloads a signed receipt as PDF

**Paths**: `src/receipt/**`, `specs/receipt/**`

**Needs**: ACME-502 (price a delivery from the mesa zone table)

Once a delivery is priced, the customer can download a receipt as a PDF, signed so they can
prove it came from ACME.

## Behaviour

`GET /deliveries/:id/receipt`

- `200` with `content-type: application/pdf` and a valid PDF (it starts `%PDF-`). The PDF's
  text is not compressed, so it can be searched, and names:
  - the delivery id and the order id;
  - each crate: product id, quantity and weight;
  - the price, the surcharge and the total, each in cents (the total written as the plain
    integer, e.g. `Total: 5400 cents`).
- Header `x-acme-signature`: the lowercase hex HMAC-SHA256 of the exact response bytes,
  keyed with the `ACME_SIGNING_KEY` environment variable (read through `ctx.env`).
- `409` when the delivery is not priced yet; `404` for an unknown delivery; `503` with
  `{ "error": "receipts are not configured" }` when `ACME_SIGNING_KEY` is not set.

No PDF library is needed: a one-page PDF of text lines is a few dozen lines of code.

## Done when

- R5 holds, proved by specs under `specs/receipt/`.
- `bun run lint`, `bun run typecheck` and `bun test` pass.
