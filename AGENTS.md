# AGENTS.md

This file applies to the complete repository.

## Mission and boundaries

LilacMacro Services provides the public website, Discord application, signed control-plane snapshots, administration surface, and opt-in diagnostic-upload lifecycle for the free LilacMacro Windows application.

- Keep the project noncommercial and preserve all license and notice files.
- Never accept or distribute executable automation, coordinates, scripts, binaries, or arbitrary commands through the control plane. Remote state may only pause, skip, defer, publish codes, or change documented UTC schedules.
- Never commit credentials, tokens, Discord IDs, diagnostic archives, raw IP addresses, stable hardware identifiers, database exports, local deployment files, or generated output.
- The public macro repository and GitHub Releases remain the sole download authority. Do not proxy installers or invent an update channel.
- Diagnostic uploads are opt-in, private, time-limited, content-type constrained, and never public CDN content.
- Treat Discord, Roblox, GitHub, Cloudflare, Backblaze, Doppler, and the VPS as independently changing external systems.

## Read before changing

- Every change: `CONTRIBUTING.md`, `docs/DEVELOPMENT.md`, and the nearest scoped `AGENTS.md`.
- Architecture or contracts: `docs/ARCHITECTURE.md`.
- Authentication, signatures, uploads, moderation, rate limits, or deployment: `docs/THREAT-MODEL.md` and `docs/OPERATIONS.md`.
- Product/UI: `PRODUCT.md` and `DESIGN.md`.
- Releases: `docs/RELEASING.md`.

## Non-negotiable security invariants

- Discord OAuth requests use PKCE, an exact redirect allowlist, short-lived one-time state, hashed server-side sessions, Secure/HttpOnly/SameSite=Lax cookies, and exact admin user-ID authorization from Doppler.
- Every mutating admin or bot operation is authorized independently, validated against a closed schema, transactionally persisted, and appended to an immutable audit log without secrets.
- Public control snapshots are canonical JSON signed with Ed25519. Clients reject unknown schema versions, expired snapshots, invalid signatures, rollbacks, and unsafe values while retaining a bounded last-known-good snapshot.
- Upload authorization is server-issued, single-purpose, short-lived, scoped to one install pseudonym and object key, and constrained by declared size. The API never exposes Backblaze master credentials.
- Raw IP addresses and hardware identifiers are never stored. Abuse keys are rotating HMAC pseudonyms; logs redact credentials and signed URLs.
- Database, object keys, filesystem paths, archive members, URLs, and shell arguments are treated as hostile input. Reject traversal, reparse/symlink escapes, ambiguous encodings, and unbounded payloads.
- Production and staging use distinct secrets, databases/schemas, domains, buckets/prefixes, OAuth redirects, and signing keys.

## Source health and required loop

- Node.js 24 LTS, TypeScript strict mode, ESM, npm lockfile.
- Production source files stay at or below 500 lines; tests at or below 800; scripts at or below 500.
- Preserve direction: `contracts <- domain <- infrastructure <- applications`.
- Before handoff run `npm run check`, `npm test`, `npm run test:coverage`, `npm audit --audit-level=high`, and `git diff --check`.
- Add positive, negative, malformed, boundary, replay, authorization, and redaction tests in proportion to risk.
- Do not weaken checks to obtain a green build.

## Deployment

- Deploy from verified `main` only through the gated workflow or the documented manual fallback.
- Use the unprivileged application account, immutable commit-derived staging, an exclusive deployment lock, health-gated promotion, and automatic rollback.
- Root is break-glass only. Do not print or copy secret values into logs, prompts, commits, or build artifacts.
