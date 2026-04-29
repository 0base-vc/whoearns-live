# Security Policy

## Supported versions

WhoEarns is pre-1.0. Only the latest `0.x` minor line
receives security fixes. Older `0.x` lines are not supported.

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | Yes (latest minor) |
| < 0.1   | No                 |

Once a `1.0` series exists, the policy will be updated to cover the
current major line and the most recent previous major.

## Reporting a vulnerability

**Do not open a public GitHub issue.** Public issues are visible to
everyone the moment they are filed.

Instead, use GitHub private vulnerability reporting on the repository, or
email `security@whoearns.live` with:

- A description of the issue.
- The component(s) affected (API, worker, migrations, Helm chart, etc.).
- Steps to reproduce, or a proof of concept, if available.
- The version (`package.json` version field or image tag) you reproduced
  against.
- Your preferred contact information and whether you want
  acknowledgement on any published advisory.

You can optionally encrypt the email with a key published alongside
this file in future releases.

### Response SLA

- We acknowledge receipt within **72 hours**.
- We aim to share an initial triage (confirmed / not-reproducible /
  need-more-info) within **7 days**.
- Fix timelines depend on severity and surface. Critical,
  remotely-exploitable issues are prioritised over everything else.

### Disclosure

We follow coordinated disclosure. Once a fix is available we publish a
GitHub Security Advisory and a `CHANGELOG.md` entry. We are happy to
credit reporters who wish to be credited.

## Scope

In scope:

- The Node.js service (`src/`) — the API and the worker.
- The Helm chart (`deploy/helm/whoearns-live`) and its
  default values.
- The Dockerfile / Docker Compose assets under `deploy/docker`.
- SQL migrations under `src/storage/migrations`.

Out of scope:

- Third-party RPC providers (Solana RPC nodes, Jito infrastructure). Report
  issues with those services to their operators directly.
- The PostgreSQL project itself. Report issues to upstream.
- Vulnerabilities in your own deployment of the chart that result from
  user-supplied values (for example, exposing the API on the public
  internet without an ingress).

## Non-security considerations

Some things that might look like vulnerabilities are intentional:

- **The HTTP API is unauthenticated by default.** It is designed to be
  consumed by an in-cluster exporter. Put it behind an authenticated
  ingress if you expose it publicly.
- **CORS is disabled.** The hosted UI uses the same origin as the API.
  Browser clients on other origins should proxy the API or self-host.
- **The indexer trusts the upstream Solana RPC as a data source.** A
  compromised or malicious RPC can poison the database. Run against a
  trusted RPC provider.
- **The `*` watch list mode issues a high volume of RPC traffic.** That
  is documented behaviour, not a DoS vector in the indexer itself.
- **Lamport totals are reported as decimal strings** because `u64` can
  overflow JavaScript `Number`. If your client parses them as
  `Number` and gets a wrong value, that is a client bug.
