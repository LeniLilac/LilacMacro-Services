# Operations

## Environments

| Environment | Domain                         | App directory                      | Data                                                         |
| ----------- | ------------------------------ | ---------------------------------- | ------------------------------------------------------------ |
| Production  | `macro.expeditions.gg`         | `/opt/lilacmacro-services`         | production Doppler config/database/bucket prefix/signing key |
| Staging     | `staging.macro.expeditions.gg` | `/opt/lilacmacro-services-staging` | isolated staging values                                      |

The site, OAuth console, signed API, and diagnostic broker use one canonical origin per environment. A pinned remotely managed Cloudflare Tunnel is the only public ingress. The API remains host-published on loopback for operator recovery, but that path is not a trusted proxy and cannot supply visitor identity through forwarding headers.

Before the first deployment or after changing the public hostname, run the built `configure:cloudflare` command through Doppler. It idempotently creates or updates one named tunnel, its exact hostname-to-`http://api:3100` ingress plus a 404 catch-all, the canonical proxied CNAME, proxied apex/`www` tunnel aliases, and one host-scoped permanent redirect rule from apex/`www` to the canonical origin while preserving path and query. `CLOUDFLARE_API_TOKEN` is an account-owned token limited to Cloudflare Tunnel Write; `CLOUDFLARE_API_TOKEN_DOMAIN` is a separate token limited to Zone Read, DNS Write, and Dynamic URL Redirects Write for the exact zone. The provisioner never sends either token to the other resource scope. The returned tunnel credential is written directly to Doppler over stdin and is never printed. Production defaults to the `lilacmacro-services-production` tunnel; staging must use a distinct tunnel name and Doppler configuration.

Cloudflare configuration does not by itself make the hostname authoritative. Before declaring an environment public, query the parent zone's public nameservers and confirm which DNS provider is delegated. If the existing registrar DNS remains authoritative, create or replace only the environment hostname there with a CNAME to the provisioned `<tunnel-id>.cfargotunnel.com` target and remove any conflicting parking record. Do not change the zone nameservers merely to activate this service. A full nameserver migration is a separate operation: first reproduce and verify every existing zone record in Cloudflare, then change delegation at the registrar. Once Cloudflare is authoritative, remove parking origins instead of leaving them behind the proxy; the provisioner owns the apex, `www`, and canonical macro records. After either activation path, require public recursive DNS to return the intended Cloudflare answers, require apex/`www` to redirect to the canonical origin with path and query intact, and require the canonical HTTPS `/health/ready` response; Cloudflare dashboard state or an origin-loopback check is insufficient proof.

The existing VPS host and unprivileged deploy identity are recorded only in `.local/vps.info`. Root access is break-glass.

## Health and rollback

- `/health/live` proves the process is alive.
- `/health/ready` verifies database connectivity and signing/public-key consistency without contacting optional vendors. The deployment gate additionally fetches `/v1/control` inside the API container and verifies its exact Ed25519 signature, schema, freshness, and lifetime using the configured public key before checking the public origin.
- `cloudflared tunnel ready` verifies an established edge connection, and the deployment gate then reaches `/health/ready` through the canonical HTTPS origin.
- Deployment stages an exact Git commit, builds its immutable application image once for reuse by every Node role, waits for PostgreSQL to report healthy, provisions runtime roles in a fail-closed one-shot phase, then runs migrations under a separate fail-closed phase. It starts the candidate, waits for readiness, and prunes the prior release only after success.
- A failed readiness check restores the previous source/image/database-compatible process set.
- A new public write path with a new retention owner requires two healthy releases. First deploy its schema, repository, and cleanup-capable worker while production composition keeps the route disabled; only a later commit may enable the route. This makes rollback land on a release that still owns every record the public path could have created.

## Proxy and cache behavior

- Only the fixed `cloudflared` edge-network address is trusted. Direct loopback requests and user-supplied `X-Forwarded-For` or `CF-Connecting-IP` values cannot select a rate-limit or diagnostic pseudonym.
- Public assets cache for one hour and may be served stale for one day during an origin error. Public HTML caches for five minutes. Signed control snapshots cache for 30 seconds with a five-minute stale-on-error window.
- OAuth, administration, telemetry ingestion, diagnostics, internal APIs, and health endpoints always return `no-store`.
- Read-only administrator data endpoints under `/v1/admin-data` also return `no-store`, require a scoped bearer key, and remain outside the Cloudflare Access-protected `/admin*` browser path so automation can authenticate directly.

Telemetry is retained for at most 90 days. The worker deletes up to 10,000 expired rows during each maintenance loop, which bounds each transaction while exceeding the 100,000-event global daily admission budget over a day of normal worker operation. Admission also caps serialized request bytes at 64 MiB globally per UTC day and uses telemetry-specific rotating network pseudonyms to cap each network at 2,048 events and 4 MiB per day. Verify the cleanup log remains clear and query the authenticated 30-day aggregate view from the control desk. The public API role can insert bounded rows and call the bounded aggregate function, but cannot read or delete raw telemetry. Never export installation or network pseudonyms or join them to diagnostic metadata. Telemetry uses HMAC domains separate from diagnostics and rotates monthly, so active-installation counts spanning a month boundary are estimates rather than stable-user counts. Public telemetry has no genuine-client proof and must be treated as forgeable and deniable: review sample size, anomalies, and statistical evidence manually, and never automatically feed telemetry into bundled reward distributions or signed control policy.

Configuration-share payloads are retained for at most 30 days and are deleted in batches of 1,000 each maintenance pass. Admission is capped at 1,000 shares/128 MiB globally and 20 shares/5 MiB per rotating share-network pseudonym per UTC day, in addition to the route limit of 10 creates per hour and 60 reads per minute per network. Treat 20-character share codes as bearer secrets: do not log them, add them to diagnostics, or expose them through administration. Retrieval uses the fixed `/v1/shares/resolve` POST path with JSON so the code does not enter edge/origin URL logs, and only its hash is stored. The API role reaches the share table only through quota-owning create and exact-hash find functions. The service stores and returns the opaque payload but does not parse or index its Plan content.

### Read-only API keys

Create keys only from **Control Desk → API keys**. Select the minimum required scopes and shortest practical lifetime. The full token is shown once; store it in a local secret manager or Doppler, never source control, logs, screenshots, chat, or diagnostic archives. The API stores only its hash and cannot recover it.

Start at `GET /v1/admin-data` with `Authorization: Bearer <key>`. The returned catalog contains only the resources granted to that key:

- `control:read` → `/v1/admin-data/control`
- `diagnostics:read` → `/v1/admin-data/diagnostics?limit=100` (metadata only; no hash, contents, or download authority)
- `telemetry:read` → `/v1/admin-data/telemetry?days=30` (bounded aggregates only)
- `audit:read` → `/v1/admin-data/audit?limit=100`

Revoke an unused, copied, or suspected-exposed key immediately from the same page. Creation and revocation appear in the immutable audit page; last-use time and count are operational hints, not proof that a key was never copied. API keys never authorize writes, diagnostic downloads, or further credential creation.

- Keep Cloudflare Always Online disabled for the API origin because it overrides documented stale behavior.

The release worker accepts the newest exact `vX.Y.Z` non-draft release, including GitHub prereleases during public beta, only when all six official assets and their GitHub SHA-256 digests are present. The website fallback links to the repository's complete Releases page because GitHub's `/releases/latest` route excludes prereleases.

## Secrets

Production secrets are read from Doppler at deployment/runtime. Never run commands that print the environment or Doppler secret values. Rotate Discord, Backblaze, OAuth-session, signing, pseudonym-HMAC, and database credentials independently. Ed25519 public keys may be published; private seeds may not.

Compose injects only the credentials each process uses:

- API: Discord OAuth, administrator allowlist, session/CSRF, OAuth-state, upload-authorization, pseudonym, the API-to-control and bot-to-API bearer tokens, the read-oriented API database role, and a Backblaze key limited to creating/uploading/downloading objects under the diagnostic prefix. It never receives the signing private key or worker token.
- Control: the Ed25519 signing private key, exact public key/key ID, all three distinct internal caller tokens, administrator allowlist, and the control-writer database role. It has no public host port, Discord credential, OAuth/session secret, or Backblaze key.
- Bot: Discord bot credentials, administrator allowlist, and only its bot bearer token for private API/control calls. It has no database, signing, Backblaze, OAuth/session, pseudonym, or upload-authorization credential.
- Worker: its worker bearer token, worker database role, cleanup-oriented Backblaze key, and optional GitHub/Roblox probe credentials. It has no Discord, administrator, OAuth/session, pseudonym, upload-authorization, or signing-private-key secret.

The API, bot, and worker bearer tokens must be generated independently. The database owner credential is used only by the dedicated one-shot `migrator` profile, which receives neither signing material nor internal service tokens, and is not injected into any long-running application container. Control and PostgreSQL attach only to the Docker-internal backend network; the signing container must fail the staging outbound-network canary. API, bot, and worker use a distinct provider-egress network. The API and worker Backblaze application keys must be distinct; verify their capabilities and prefix restriction in staging before production.

Provision the two process-specific Backblaze keys once with `npm run provision:backblaze-keys` under Doppler. `BACKBLAZEMASTERKEYID` and `BACKBLAZEMASTERKEYTOKEN` identify the account Master Application Key and are used only for Native API key creation, rollback, and exact private-bucket verification. `BACKBLAZEBUCKETKEYID` and `BACKBLAZEBUCKETKEY` retain the existing S3-compatible bucket credential and are used only to install and reread the diagnostic-prefix lifecycle rule. Never reuse either bootstrap credential as a runtime key. The command creates bucket- and prefix-restricted API and worker keys with distinct capabilities, writes each secret to Doppler over stdin, and compensates provider/Doppler state if secret storage fails. The lifecycle rule permanently deletes noncurrent versions and aborts unfinished multipart uploads after one day; application deletion remains authoritative and removes every exact object version immediately. No bootstrap credential enters a long-running container. Then run `npm run verify:backblaze` in a disposable provider proof before deployment; this proves exact signed part length/checksum behavior, completed-session replay rejection, full-version cleanup, reconciliation visibility, and both process capability boundaries against Backblaze itself.

Keep process-specific environment blocks separate when adding a credential. A service must fail startup if one of its own required values is missing, but it must not require or receive another service's credentials.

## Diagnostic lifecycle

The worker runs every minute and:

1. claims completed uploads and streams each object to verify its exact byte count and SHA-256;
2. retries transient verification failures with bounded backoff and deletes permanent mismatches;
3. aborts multipart sessions older than 12 hours;
4. deletes any legacy Pending uploads left from the retired grant workflow;
5. deletes rejected/expired objects and tombstones metadata;
6. lists incomplete multipart uploads under the exact service prefix and aborts provider uploads older than 12 hours that are absent from repository state;
7. enforces the configured storage-time budget and per-install/IP quotas.

All new automatic diagnostic archives use the same 3 GiB maximum. The control desk exposes review,
download, and deletion only; it cannot issue upload grants, accept Pending archives, or extend
retention. The legacy grant tables remain inert during the rollback-compatibility window, and the
worker continues deleting any pre-removal Pending records.

Deletion is idempotent. A failed provider deletion remains queued and is retried with bounded backoff; stale `Deleting` leases are reclaimed after 15 minutes, metadata is not reported deleted until storage confirms that every exact-key version and delete marker is absent, and Expired metadata continues to consume the global retained-byte budget until that confirmation. Provider control requests use explicit deadlines, full-object verification has a size-bounded deadline, and worker shutdown cancels active work and schedules a bounded retry before the container grace period ends. Multipart reconciliation continues through the complete claimed page even when one abort fails. The provisioned one-day Backblaze noncurrent-version and incomplete-multipart lifecycle rule is defense in depth and does not replace application reconciliation.

After inspecting an accepted archive, an administrator should use Delete from the control desk or `/macro-diagnostic action:Delete`. This records the actor, claims the archive with a compare-and-swap status transition, and uses the same provider-confirmed deletion and retry path as automated expiry. Routine retained storage is capped globally at 900 GiB so even a continuously full allocation remains under the accepted monthly TB-hour budget.

## Incident priorities

1. Revoke exposed credentials and disable affected endpoints.
2. Preserve audit metadata without copying diagnostic contents.
3. Publish a signed maintenance/disablement snapshot if the control plane remains trustworthy.
4. Roll back deployment or stop the service if signing/admin authority is uncertain.
5. Document scope, remediation, and required client action.
