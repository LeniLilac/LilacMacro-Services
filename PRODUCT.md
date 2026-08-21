# Product

## Register

product

## Purpose

LilacMacro Services lets a small volunteer team safely publish current game-operational knowledge to public LilacMacro installations, administer that state through Discord or a web console, provide a clear public landing page, receive bounded product telemetry after a versioned first-run choice, and receive separately opted-in diagnostic archives for short-lived debugging.

## Users

- Macro users need trustworthy status, codes, schedules, downloads, and transparent maintenance behavior without creating an account.
- Macro administrators need fast Discord and web workflows for codes, maintenance, schedules, feature disablements, and diagnostic decisions.
- The project owner needs a low-operations system that fits an existing Hetzner VPS and Backblaze account.

## Product principles

- Free-software practicality over enterprise ceremony.
- Remote policy narrows behavior; it never expands automation authority.
- Safe offline behavior: signed last-known-good state, clear staleness, no cloud dependency for ordinary local operation.
- Versioned choices before telemetry or automatic diagnostics, visible size/retention, and independently controllable data paths.
- One authoritative operation model shared by the bot and admin portal.
- GitHub Releases remain the download source of truth.

## Core capabilities

- Signed, cacheable control snapshot with maintenance status, codes, shop schedules, and feature/task disablements.
- Discord application and Discord-OAuth admin console over the same authenticated command service.
- Public landing, setup, privacy, status, and download pages.
- Direct-to-Backblaze multipart diagnostic uploads with on-demand verification before administrator download, lifecycle cleanup, quotas, and moderation.
- Fixed-schema telemetry ingestion, monthly rotating installation pseudonyms, 90-day deletion, and authenticated aggregate summaries for use, rewards, errors, OCR timing by normalized CPU/GPU model, and display/UI-scale calibration.
- Aggregate telemetry is advisory and requires human review; it never automatically changes bundled reward distributions or signed control policy.
- Periodic macro polling with jitter, signature/rollback/expiry validation, and last-known-good fallback.

## Explicit non-goals

- Remote code execution, remote input scripts, detector/coordinate delivery, arbitrary configuration mutation, telemetry before the versioned choice is saved, public diagnostic sharing, installer proxying, or commercial subscriptions.
