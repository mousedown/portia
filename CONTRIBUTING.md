# Contributing to Portia

Thanks for helping. Bug reports, fixes and new tracker or gate support are all welcome.

## Before you start

- **A bug:** open an issue with the bug template. Include `portia version`, the command you ran, and the run log from `~/.portia/runs/<KEY>/` if a run went wrong.
- **A feature:** open an issue first so we can agree the shape before you build it. Portia's rules (spine first, gates re-run after every rebase, never merge to `main`) are deliberate, so changes to them need a discussion.

## Develop

You need [Bun](https://bun.sh), git and the [GitHub CLI](https://cli.github.com).

```sh
bun install
bun run typecheck
bun run lint
bun run test
```

The suite includes an end-to-end run with no network and no model calls. Design tests need Chromium: `bunx playwright install chromium`. See [Development](docs/reference.md#development) for CI and fixtures.

To try your checkout as the installed Portia, run `./scripts/install.sh` from it: it links this checkout's CLI and skills in place.

## Pull requests

- Title in conventional-commit form: `feat(drive): …`, `fix(plan): …`, `docs: …`.
- Keep typecheck, lint and tests green; add a test for the behaviour you change.
- Update `docs/reference.md` when you change a command, a profile field or a rule.
- Never use real company or project names in fixtures or examples: `test/core/no-project-names.test.ts` checks this. Use `ACME`.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
