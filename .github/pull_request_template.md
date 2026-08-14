## Summary

Describe the behavior and operational impact of this change.

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run test:coverage`
- [ ] `npm audit --audit-level=high`
- [ ] `git diff --check`
- [ ] Relevant staging/provider validation completed or documented as deploy-only

## Security and operations

- [ ] No credentials, diagnostics, private captures, local paths, or generated output were added
- [ ] Contract, OAuth, signature, upload, proxy, and deployment changes were reviewed against `docs/THREAT-MODEL.md`
- [ ] Migrations preserve forward and rollback compatibility
- [ ] User-facing and operational documentation is current
