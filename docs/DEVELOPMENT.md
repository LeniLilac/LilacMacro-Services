# Development

## Toolchain

- Node.js 24 LTS
- npm with committed lockfile
- TypeScript strict ESM
- PostgreSQL 17
- Docker and Docker Compose

## Commands

```bash
npm ci
npm run check
npm test
npm run test:coverage
npm audit --audit-level=high
docker compose up --build
```

`npm run check` validates formatting conventions, repository policy, type safety, and production builds. Tests use isolated temporary data and never require real Discord, GitHub, Backblaze, Doppler, Roblox, or VPS access.

## Local configuration

Copy `.env.example` to `.env` only for disposable local values. Owner service tokens and SSH credentials live under ignored `.local`; production values remain in Doppler. Never print the output of `doppler secrets`, `.env`, signed URLs, session cookies, OAuth codes, or object-storage credentials.

## Source layout

- `src/contracts`: closed external schemas and canonical serialization.
- `src/domain`: policy and operations independent of transport/vendors.
- `src/infrastructure`: PostgreSQL, Discord, GitHub, Backblaze, crypto, and HTTP adapters.
- `src/apps`: API, bot, worker, and web composition roots.
- `public`: static UI assets with no embedded secrets.
- `migrations`: append-only database migrations.
- `ops`: deployment and server configuration.
- `test`: unit and integration coverage.
