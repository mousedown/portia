<p>Some text the PR author wrote.</p>
<table><tr><td>1</td><td>not the ledger</td></tr></table>
| 9 | NOT-1 outside the markers | landed | #1 | X1 ✓ | matched |  | opus |

<!-- epic-ledger:start -->
## Ledger: ACME-500

| Wave | Child | State | PR | Requirements | Touches | Design | Model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | ACME-501 Invoice model and line items | landed | #415 | R1 ✓ | matched |  | opus |
| 1 | ACME-502 Price a line item from the plan catalogue | landed | #418 | R2 ✓ | matched |  | sonnet |
| 1 | ACME-503 Tax rules per billing country | landed | #421 | R3 ✓ | **outside touches** |  | opus |
| 2 | ACME-504 Invoice list for team admins | landed | #427 | R4 ✓ | matched |  | sonnet |
| 2 | ACME-505 Team admins download an invoice as PDF | running |  | R5 ✗ |  |  | sonnet |
| 2 | ACME-506 Email the invoice when a billing period closes | running |  | R6 ✗ |  |  | opus |
| 3 | ACME-507 Credit notes reverse a paid line item | pending |  | R7 ✗ |  |  |  |
| 4 | ACME-508 Usage-based lines from metered events | pending |  | R8 ✗ |  |  |  |

### Evidence

- ACME-501 R1: bun test invoice/ → 31 pass, 0 fail; acceptance invoice.itest.ts 4 passed
- ACME-502 R2: pricing acceptance 3 passed; a plan with no price refuses to invoice
- ACME-503 R3: tax.itest.ts 6 passed; a country with no rule falls back to zero-rated
- ACME-504 R4: invoice-list.spec.tsx 9 passed; an admin of two teams sees both lists

_Rendered from the tracker, GitHub and the run log. Edits between the markers are overwritten._
<!-- epic-ledger:end -->
