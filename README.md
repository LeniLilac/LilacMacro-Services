# LilacMacro Services

Private service repository for the LilacMacro public website, Discord application, signed control-plane API, and opt-in diagnostic-upload lifecycle.

The Windows macro remains in the separate LilacMacro repository. This service never supplies executable automation or installer content; downloads resolve directly to official GitHub Releases.

The public landing page also exposes Discord's provider-owned install flow. Commands support both user and guild installation contexts, but every operation still checks the closed administrator-ID allowlist independently.

## Development

Requirements: Node.js 24 LTS, npm, Docker, and Docker Compose.

```bash
npm ci
npm run check
npm test
docker compose up --build
```

See `docs/DEVELOPMENT.md`, `docs/ARCHITECTURE.md`, and `docs/THREAT-MODEL.md` before making changes.
