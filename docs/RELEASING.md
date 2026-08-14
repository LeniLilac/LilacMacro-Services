# Releasing

1. Confirm the worktree contains no `.local`, `.env`, diagnostics, database files, or generated output.
2. Run `npm ci`, `npm run check`, `npm test`, `npm run test:coverage`, `npm audit --audit-level=high`, and `git diff --check`.
3. Review migrations for forward and rollback compatibility.
4. Review changes to contracts, OAuth, signatures, uploads, proxy trust, and deployment against `docs/THREAT-MODEL.md`.
5. Merge or push the verified commit to `main`; the gated deploy workflow verifies the exact SHA before promotion.
6. Confirm `/health/ready`, signed snapshot verification, public pages, Discord command registration, and worker cleanup metrics in staging before production.

GitHub Releases for the Windows macro are published from the LilacMacro repository. This service only displays direct verified links.
