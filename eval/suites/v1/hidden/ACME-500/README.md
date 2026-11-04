# Hidden specs: ACME-500

One file per scenario, named `<ID>.spec.ts` (`R1.spec.ts` … `R8.spec.ts`), runnable by the
repo's `test` command from `suite.json` after being copied into `.eval-hidden/` in the arm's
final clone. Exit 0 is a pass.

They are written and reviewed by a person **before any run**, against the scenario text in
`suite.json`, the tickets in `../../tickets/` and the acme-shop API, and never committed to the
acme-shop repository. Changing one after a run voids the iteration (see the eval epic (GH-79)).

This directory holds no specs until the acme-shop repository exists; the harness scores a
missing spec as a fail and says so in the log.
