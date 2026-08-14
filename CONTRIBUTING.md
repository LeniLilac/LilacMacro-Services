# Contributing

LilacMacro Services is a noncommercial passion project. Changes should be small, inspectable, tested, and consistent with the security boundaries in `AGENTS.md`.

1. Read `AGENTS.md` and the relevant docs.
2. Preserve unrelated work and never add `.local`, diagnostics, credentials, or generated output.
3. Add regression tests before or with the implementation.
4. Run `npm run check`, `npm test`, `npm run test:coverage`, `npm audit --audit-level=high`, and `git diff --check`.
5. Update user-facing and operational documentation in the same change.
