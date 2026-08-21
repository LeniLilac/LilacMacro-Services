# Testing

## Required local gate

Run the complete gate before a commit or deployment:

```bash
npm ci
npm run check
npm run test:coverage
npm audit --audit-level=high
git diff --check
```

`npm run check` covers formatting, repository policy, strict type checking, and the production build. `test:coverage` runs unit, boundary, and PostgreSQL integration tests with minimum thresholds of 80% lines/statements/functions and 75% branches. Tests start an isolated temporary PostgreSQL instance and never use owner Discord, Backblaze, GitHub, Roblox, Cloudflare, Doppler, or VPS credentials.

The Linux staging rehearsal in `ops/verify-staging.sh` uses generated disposable secrets and a unique Compose project. It provisions the three runtime database roles, applies migrations, starts Control and API, proves Worker becomes unhealthy rather than falsely ready when its intentionally unreachable storage dependency fails, proves bounded Worker shutdown, proves allowed and denied role operations, forces API readiness to fail by removing its published snapshot, verifies Control republishing restores readiness, and exercises both prior-release rollback and fail-closed first-deploy teardown. Its containers, network, volume, and temporary environment file are removed on every exit. A separate credentialed staging check must prove Worker healthy against the restricted Backblaze key before deployment. The credentialed provider check uploads bounded one- and multi-part multipart objects, proves signed part headers reject wrong lengths and checksums, proves completed-session part replay rejection, verifies exact assembled bytes through the service SHA-256 stream, exercises multipart listing/abort, creates multiple object versions, and proves all versions are permanently removed. Query-hoisted checksums do not satisfy this proof.

Run the credentialed provider proof only in a controlled staging environment with the isolated API and worker application keys: `npm run build && npm run verify:backblaze`. The verifier checks the exact bucket/prefix/capability split, proves the API key cannot list multipart uploads, creates only random `provider-check` objects below 12 MiB total, and removes or aborts every tracked object in a `finally` path.

## Risk-focused coverage

- Canonical JSON and Ed25519 tests must include unknown-key, tamper, rollback, future-time, and expiry negatives.
- Admin commands must cover authorization, actor ownership, revision conflicts, idempotency, schema rejection, and public-payload filtering.
- OAuth tests must cover PKCE, browser binding, expiry, one-time consumption, session revocation, CSRF, and provider failure.
- Diagnostics must cover consent, quotas, multipart bounds, token binding, stored-without-verification expiry, idempotent on-demand download requests, full-object byte/hash verification before download, administrator deletion, fair retained-capacity eviction, provider-failure re-accounting, deletion retries, and cleanup expiry.
- Deployment changes require a rendered Compose configuration, container build, migration rehearsal, readiness failure, and rollback rehearsal in staging.

External live checks are staging-only and opt-in. Never make a test depend on production credentials or mutate production state.
