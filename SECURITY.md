# Security policy

## Reporting a vulnerability

Please report vulnerabilities [privately through GitHub](https://github.com/mousedown/portia/security/advisories/new), not in a public issue or pull request.

Include the Portia version (`portia version`), what an attacker needs to be able to do, and the steps to reproduce it. Portia has one maintainer, so replies are best effort. A confirmed issue is fixed in a new release and credited in its advisory, if you would like that.

## Supported versions

Only the latest release gets security fixes.

## What counts

Portia's workers are Claude Code sessions that read ticket text and run commands. Its rules keep a run on track, but they are not a sandbox: [What these rules do not protect against](docs/reference.md#what-these-rules-do-not-protect-against) lists the limits we already document.

These are vulnerabilities we want to hear about:

- Ticket or plan text that runs a command without passing through a worker's permission checks.
- A way for a run to reach `main`, or to land a child without passing its gates.
- A way for a worker to record a person's approval.
- Credentials written to a run log, ledger, PR or other output.
- Anything in the installer, or in the release pipeline, that could deliver code you did not ask for.
