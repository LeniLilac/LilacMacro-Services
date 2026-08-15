# Architecture

## System boundary

LilacMacro Services is one deployable repository with four least-authority processes over one PostgreSQL database and one private Backblaze bucket:

```text
GitHub Releases --------------------> Public website (direct links)
                                              |
Discord OAuth ---> API -----private command-->|
Discord bot ------private command------------>| Control signer ---> PostgreSQL control state/audit
Worker probes ----private system command------>|       |
                                                       +---> Ed25519 signed public snapshot
LilacMacro clients ---> API snapshot + scoped Backblaze upload grants
Worker ----------------> verification, expiry, deletion, multipart reconciliation
```

The API serves the public site and admin console, owns OAuth/session authorization, exposes the signed snapshot, ingests fixed-schema telemetry, and brokers diagnostic upload sessions. Telemetry ingestion uses strict per-kind allowlists; daily 100,000-event/64-MiB global and 2,048-event/4-MiB rotating-network capacity reservations; one bulk insert per batch; and a bounded security-definer aggregate that does not expose raw pseudonyms. The API role cannot select or delete raw telemetry. The worker deletes at most 10,000 expired telemetry rows per maintenance pass so retention can catch up without one unbounded transaction. The bot maps Discord slash commands onto authenticated private API/control calls and has no database or storage credential. The private control process is the only holder of the Ed25519 signing key and the only runtime database role allowed to mutate control state or append command audit. Control and PostgreSQL live only on a Docker-internal backend network, so the signing container has no provider or Internet egress; API, bot, and worker are separately dual-homed onto an explicit provider-egress network. The worker holds the cleanup-oriented storage key and handles time-based verification, diagnostic and telemetry deletion, storage reconciliation, release polling, public Roblox universe-listing polling, and snapshot republishing. The Roblox probe intentionally does not use the authenticated-user playability endpoint: an unauthenticated request represents a guest and can falsely report a public experience as unavailable. No process can send executable automation to a macro.

Telemetry accepts at most 64 events and 64 KiB per request from the exact public endpoint. Zod and PostgreSQL both enforce the same discriminated event-kind, enum, numeric, and timestamp bounds. The API immediately HMAC-pseudonymizes the random client installation UUID and normalized source network with separate telemetry-specific monthly domains; the database stores neither source value, and neither diagnostic pseudonym can be joined to them. The network pseudonym is used only for the daily abuse budget. Fixed columns prevent arbitrary JSON/log retention. The worker deletes rows and capacity records after 90 days, while authenticated administrators see at most 250 grouped counts, estimated rotating installations, average timings, and quantity totals through a security-definer function. Public clients remain unauthenticated, so aggregates are untrusted and may be forged or denied despite bounded quotas; they are advisory only and never automatically alter application or control policy.

A pinned `cloudflared` process is the sole public ingress and shares a dedicated two-member edge network only with the API. The API trusts exactly the tunnel container address, derives public-client identity only from its single `CF-Connecting-IP` value, and never uses `X-Forwarded-For` for abuse controls. The loopback host port remains available for recovery without entering that trust boundary.

Each private caller has a distinct bearer token. API, control, and worker use distinct PostgreSQL roles. API and worker use separate Backblaze application keys with different capabilities; control and bot receive no Backblaze key. The control service is reachable only on the internal Compose network and publishes no host port.

## Layer direction

`contracts <- domain <- infrastructure <- applications`

- Contracts define versioned external data and canonical encodings.
- Domain owns authorization-independent business rules and transactions.
- Infrastructure implements persistence, signatures, vendors, and clocks.
- Applications adapt HTTP, Discord, control, and worker scheduling.

## Public control snapshot

The snapshot contains only:

- schema/revision/generated/expiry timestamps;
- game availability and maintenance message;
- active redeem codes and expiry metadata;
- UTC shop-reset schedules whose next occurrence is the repeating cycle anchor;
- closed feature/task disablement identifiers with reason and expiry;
- public release metadata copied from the exact GitHub Release.

The payload is canonical JSON and Ed25519-signed. Revision is monotonic. Clients reject invalid signatures, unknown schemas, expired or future-dated content, and revision rollback. A valid last-known-good snapshot may be used during a bounded outage.

## Diagnostics

Routine archives up to 3 GiB may be explicitly uploaded and are automatically accepted for 72 hours. Archives over 3 GiB through 30 GiB require an explicit manual upload and enter Pending; an admin must accept within 30 minutes or the worker deletes the object. Each large-upload authority is persisted, attributed to its issuing administrator, bound to one preassigned upload/object/install/size/kind tuple, consumed transactionally once, and recorded in immutable audit. Accepted large archives default to 72 hours and may be extended to at most seven days.

Administrators may explicitly delete accepted or stalled archives after review. The operation first claims lifecycle ownership transactionally, records the administrator in immutable audit, removes or aborts the provider object, and reports `Deleted` only after provider confirmation. Failures enter the same bounded deletion-retry lifecycle as retention cleanup. The global retained-object budget is 900 GiB, approximately 696 decimal TB-hours over a 30-day month, below the project's 730 TB-hour allowance.

Objects are private, encrypted by the provider, content-type constrained, random-keyed, and uploaded only through multipart sessions; a small archive is a one-part multipart upload. Each part URL expires after one hour and binds one upload ID, part number, exact byte count, and SHA-256 request header. Completed multipart sessions reject part-URL replay, avoiding reusable whole-object PUT capabilities that could create unmetered versions. Completion still only queues verification: the worker streams the assembled object through SHA-256 and checks its exact byte count before the object can become Pending or Accepted. Deletion lists and permanently removes every version and delete marker for the exact random object key before terminalizing metadata. A provider lifecycle rule under the diagnostic prefix deletes noncurrent versions and aborts unfinished multipart uploads after one day as defense in depth. Metadata—not archive content—is stored in PostgreSQL. The service never automatically extracts user archives.

## Availability

One VPS is an accepted single point of failure. Cloudflare caches immutable public assets and short-lived public status/snapshot responses. Clients jitter polling and retain signed last-known-good state, so an outage does not create a request storm or stop an otherwise safe local run.

The public landing page is rendered from the same fresh, signature-verified control snapshot served to macro clients. This keeps game availability readable without JavaScript and makes the primary download buttons point directly at the exact verified GitHub Release installer asset. If control data is unavailable or invalid, the page visibly reports unknown status and falls back to the official GitHub Releases page rather than trusting stale metadata.
