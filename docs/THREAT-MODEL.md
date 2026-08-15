# Threat model

## Assets

- Discord bot/OAuth credentials and exact admin IDs.
- Ed25519 control-signing private key.
- PostgreSQL data and audit history.
- Backblaze application credentials and private diagnostic objects.
- GitHub/VPS/Doppler deployment authority.
- Macro-user privacy, bandwidth, and local runtime safety.
- Pseudonymous telemetry events and aggregate operational statistics.

## Trust boundaries

Internet clients, Discord interactions, OAuth callbacks, GitHub APIs, Cloudflare headers, Backblaze callbacks/responses, database content, archive metadata, and every administrative field are untrusted. Only the dedicated `cloudflared` container address is a trusted proxy peer. The application accepts one syntactically valid `CF-Connecting-IP` value from that exact peer and ignores forwarding headers from every other source; `X-Forwarded-For` never owns rate-limit or diagnostic network identity.

Telemetry bodies are untrusted even when their installation UUID is syntactically valid. Dual application/database validation rejects unknown fields, free-form paths or log text, stale/future timestamps, oversized batches, and out-of-range numbers. Separate monthly rotating telemetry-install and telemetry-network HMAC pseudonyms reach storage; the latter owns only a bounded daily event/byte quota. Public telemetry has no genuine-client proof, so quotas contain storage/availability exposure but do not make aggregates trustworthy. Telemetry never authorizes control or diagnostics, and the control/worker database roles cannot read its table.

## Principal threats and controls

| Threat                      | Required controls                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Forged macro policy         | Ed25519 canonical signatures, pinned public key, schema/expiry/revision validation, LKG                |
| Compromised admin session   | PKCE/state, exact redirects, hashed short sessions, exact ID allowlist, CSRF checks, audit log         |
| Discord interaction forgery | Gateway library validation, exact application identity, per-command admin authorization                |
| Remote-code channel creep   | Closed control schemas; deny arbitrary strings as identifiers; no coordinates/scripts/binaries         |
| Upload cost abuse           | Explicit consent, declared-size cap, quotas, trusted-edge client identity, rotating HMAC pseudonyms    |
| Credential exposure         | Doppler injection, redaction, no secret response bodies, no signed URL logging, private bucket         |
| Path/object traversal       | server-generated UUID object keys, prefix checks, no caller-selected filesystem/object path            |
| Multipart confusion         | scoped token; exact part size/checksum grants; streamed full-object size and SHA-256 before acceptance |
| Archive bombs/malware       | never auto-extract; quarantine metadata; admin download only; content disposition attachment           |
| Snapshot rollback/replay    | monotonic revision, generated/expiry bounds, transactionally signed published revision                 |
| SSRF/open redirect          | fixed vendor origins, exact redirect allowlist, no arbitrary fetch URL, bounded redirects              |
| Supply-chain compromise     | lockfile, pinned Actions commits, audit gate, minimal production image, non-root runtime               |
| Deployment tamper           | verified main SHA, immutable staging, lock, health gate, rollback, unprivileged deploy user            |

## Privacy identifiers

The API derives short-lived abuse keys from a client-generated random install ID and normalized source IP using separate rotating HMAC keys. It stores only the keyed digest and key epoch. It does not collect raw hardware IDs. The Cloudflare tunnel runs at info level, application logs omit all request headers and source addresses, and both use bounded rotation. Raw proxy logs must not be enabled in routine operation.

## Security review gates

Use a focused defensive review before first production deployment and whenever changing OAuth/session authorization, signing/canonicalization, Backblaze authorization/completion, proxy trust, deployment, or retention deletion. Findings must be resolved or explicitly accepted before release.
