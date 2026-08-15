# Operations

## Environments

| Environment | Domain                         | App directory                      | Data                                                         |
| ----------- | ------------------------------ | ---------------------------------- | ------------------------------------------------------------ |
| Production  | `macro.expeditions.gg`         | `/opt/lilacmacro-services`         | production Doppler config/database/bucket prefix/signing key |
| Staging     | `staging.macro.expeditions.gg` | `/opt/lilacmacro-services-staging` | isolated staging values                                      |

The site, OAuth console, signed API, and diagnostic broker use one canonical origin per environment. A pinned remotely managed Cloudflare Tunnel is the only public ingress. The API remains host-published on loopback for operator recovery, but that path is not a trusted proxy and cannot supply visitor identity through forwarding headers.

Before the first deployment or after changing the public hostname, run the built `configure:cloudflare` command through Doppler. It idempotently creates or updates one named tunnel, its exact hostname-to-`http://api:3100` ingress plus a 404 catch-all, and one proxied CNAME. `CLOUDFLARE_API_TOKEN` is an account-owned token limited to Cloudflare Tunnel Write; `CLOUDFLARE_API_TOKEN_DOMAIN` is a separate token limited to Zone Read and DNS Write for the exact zone. The provisioner never sends either token to the other resource scope. The returned tunnel credential is written directly to Doppler over stdin and is never printed. Production defaults to the `lilacmacro-services-production` tunnel; staging must use a distinct tunnel name and Doppler configuration.

The existing VPS host and unprivileged deploy identity are recorded only in `.local/vps.info`. Root access is break-glass.

## Health and rollback

- `/health/live` proves the process is alive.
- `/health/ready` verifies database connectivity and signing/public-key consistency without contacting optional vendors.
- `cloudflared tunnel ready` verifies an established edge connection, and the deployment gate then reaches `/health/ready` through the canonical HTTPS origin.
- Deployment stages an exact Git commit, builds its immutable application image once for reuse by every Node role, runs migrations under a lock, starts the candidate, waits for readiness, then prunes the prior release only after success.
- A failed readiness check restores the previous source/image/database-compatible process set.

## Proxy and cache behavior

- Only the fixed `cloudflared` edge-network address is trusted. Direct loopback requests and user-supplied `X-Forwarded-For` or `CF-Connecting-IP` values cannot select a rate-limit or diagnostic pseudonym.
- Public assets cache for one hour and may be served stale for one day during an origin error. Public HTML caches for five minutes. Signed control snapshots cache for 30 seconds with a five-minute stale-on-error window.
- OAuth, administration, diagnostics, internal APIs, and health endpoints always return `no-store`.
- Keep Cloudflare Always Online disabled for the API origin because it overrides documented stale behavior.

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
4. deletes Pending large uploads after 30 minutes;
5. deletes rejected/expired objects and tombstones metadata;
6. lists incomplete multipart uploads under the exact service prefix and aborts provider uploads older than 12 hours that are absent from repository state;
7. enforces the configured storage-time budget and per-install/IP quotas.

For an archive over 3 GiB, the user copies the random Installation ID shown in LilacMacro Settings
and supplies that ID plus the archive's exact byte size and kind to an administrator. The
administrator uses **Diagnostics > Issue 30-minute grant** in the control desk, copies the returned
grant once, and sends it back to that user. The user pastes it into LilacMacro's Large File Grant
field before explicitly selecting the archive. The grant is attributable, tuple-bound, and consumed
once; neither side should post it in a public channel or diagnostic record.

Deletion is idempotent. A failed provider deletion remains queued and is retried with bounded backoff; stale `Deleting` leases are reclaimed after 15 minutes, metadata is not reported deleted until storage confirms that every exact-key version and delete marker is absent, and Expired metadata continues to consume the global retained-byte budget until that confirmation. Provider control requests use explicit deadlines, full-object verification has a size-bounded deadline, and worker shutdown cancels active work and schedules a bounded retry before the container grace period ends. Multipart reconciliation continues through the complete claimed page even when one abort fails. The provisioned one-day Backblaze noncurrent-version and incomplete-multipart lifecycle rule is defense in depth and does not replace application reconciliation.

After inspecting an accepted archive, an administrator should use Delete from the control desk or `/macro-diagnostic action:Delete`. This records the actor, claims the archive with a compare-and-swap status transition, and uses the same provider-confirmed deletion and retry path as automated expiry. Routine retained storage is capped globally at 900 GiB so even a continuously full allocation remains under the accepted monthly TB-hour budget.

## Incident priorities

1. Revoke exposed credentials and disable affected endpoints.
2. Preserve audit metadata without copying diagnostic contents.
3. Publish a signed maintenance/disablement snapshot if the control plane remains trustworthy.
4. Roll back deployment or stop the service if signing/admin authority is uncertain.
5. Document scope, remediation, and required client action.
