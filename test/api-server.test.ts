import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildApi, createRateLimitKeyGenerator, safeRequestPath } from '../src/apps/api-server.js';
import { CommandService } from '../src/domain/command-service.js';
import { FixedClock } from '../src/domain/clock.js';
import { DiagnosticService, type UploadStorage } from '../src/domain/diagnostic-service.js';
import { PostgresAdminApiKeyStore } from '../src/infrastructure/admin-api-key-store.js';
import { PostgresAuthStore } from '../src/infrastructure/auth-store.js';
import { PostgresConfigurationShareRepository } from '../src/infrastructure/postgres-configuration-share-repository.js';
import { loadConfig, requireApiConfig } from '../src/infrastructure/config.js';
import {
  MemoryControlRepository,
  MemoryDiagnosticRepository,
} from '../src/infrastructure/memory-repositories.js';
import { MemoryTelemetryRepository } from '../src/infrastructure/memory-telemetry-repository.js';
import { RotatingPseudonymizer } from '../src/infrastructure/pseudonym.js';
import { TrustedProxyAddressResolver } from '../src/infrastructure/trusted-proxy.js';
import { Ed25519SnapshotSigner } from '../src/infrastructure/snapshot-signer.js';
import { hashSessionToken, issueCsrfToken } from '../src/infrastructure/session-codec.js';
import { HmacUploadAuthorizer } from '../src/infrastructure/upload-authorizer.js';
import { startTemporaryPostgres } from './helpers/postgres.js';
import { assertDiagnosticInstallationSearch } from './support/diagnostic-installation-search.js';
import {
  assertBrowserAudit,
  assertFullAccessAudit,
  assertFullAccessDiagnosticMetadata,
  assertFullAccessTelemetry,
  createFullAccessKey,
  deleteFullAccessDiagnostic,
  executeFullAccessControlCommand,
  requestFullAccessDiagnosticDownload,
} from './support/admin-api-key-capabilities.js';

class ApiStorage implements UploadStorage {
  public expectedBytes = 0;

  public async beginMultipart(): Promise<string> {
    return 'provider-upload';
  }

  public async presignPart(_key: string, _uploadId: string, part: number): Promise<string> {
    return `https://upload.invalid/part/${part}`;
  }

  public async completeMultipart(): Promise<void> {}

  public async remove(): Promise<void> {}

  public async presignDownload(): Promise<string> {
    return 'https://download.invalid/archive';
  }

  public async verifySize(_key: string, expectedBytes: number): Promise<void> {
    assert.equal(expectedBytes, this.expectedBytes);
  }
  public async verifyObject(
    _key: string,
    expectedBytes: number,
    expectedSha256: string,
  ): Promise<void> {
    assert.equal(expectedBytes, this.expectedBytes);
    assert.equal(expectedSha256, 'a'.repeat(64));
  }
  public async listMultipartUploads(): Promise<
    ReadonlyArray<{ objectKey: string; uploadId: string; initiatedAt: Date }>
  > {
    return [];
  }
  public async abortMultipart(): Promise<void> {}
}

test('API boundary enforces admin authorization, CSRF, signed control, and upload lifecycle', async () => {
  const postgres = await startTemporaryPostgres();
  const signing = generateKeyPairSync('ed25519');
  const key = () => randomBytes(32).toString('base64');
  const csrfKey = key();
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:3100',
    DATABASE_URL: postgres.connectionString,
    DISCORD_BOT_CLIENT_ID: '123456789012345678',
    DISCORD_BOT_CLIENT_SECRET: 'test-only-client-secret',
    DISCORD_OAUTH_REDIRECT_URI: 'http://localhost:3100/auth/discord/callback',
    MACRO_ADMIN_IDS: '123456789012345678',
    SESSION_CSRF_HMAC_KEY_BASE64: csrfKey,
    OAUTH_STATE_ENCRYPTION_KEY_BASE64: key(),
    UPLOAD_AUTH_HMAC_KEY_BASE64: key(),
    INSTALL_PSEUDONYM_HMAC_KEY_BASE64: key(),
    NETWORK_PSEUDONYM_HMAC_KEY_BASE64: key(),
    CONTROL_SIGNING_PRIVATE_KEY_BASE64: signing.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    CONTROL_SIGNING_PUBLIC_KEY_BASE64: signing.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    CONTROL_SIGNING_KEY_ID: 'test-1',
    BACKBLAZE_BUCKET_NAME: 'test-bucket',
    BACKBLAZE_S3_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
    BACKBLAZE_REGION: 'us-east-005',
    BACKBLAZE_KEY_ID: 'test-key-id',
    BACKBLAZE_APPLICATION_KEY: 'test-application-key',
    INTERNAL_API_ORIGIN: 'http://api:3100',
    INTERNAL_CONTROL_ORIGIN: 'http://control:3101',
    INTERNAL_API_TOKEN_BASE64: key(),
    INTERNAL_BOT_TOKEN_BASE64: key(),
    INTERNAL_WORKER_TOKEN_BASE64: key(),
  });
  requireApiConfig(config);
  const clock = new FixedClock(new Date('2026-08-14T12:00:00.000Z'));
  const controlRepository = new MemoryControlRepository();
  const signer = new Ed25519SnapshotSigner(
    config.CONTROL_SIGNING_PRIVATE_KEY_BASE64!,
    config.CONTROL_SIGNING_PUBLIC_KEY_BASE64,
    config.CONTROL_SIGNING_KEY_ID,
  );
  const diagnosticRepository = new MemoryDiagnosticRepository();
  const telemetryRepository = new MemoryTelemetryRepository(1);
  const commandService = new CommandService(controlRepository, signer, clock);
  const storage = new ApiStorage();
  const diagnosticService = new DiagnosticService(
    diagnosticRepository,
    storage,
    clock,
    'diagnostics/test',
    new HmacUploadAuthorizer(config.UPLOAD_AUTH_HMAC_KEY_BASE64),
  );
  const authStore = new PostgresAuthStore(postgres.pool, config.OAUTH_STATE_ENCRYPTION_KEY_BASE64);
  const pseudonymizer = new RotatingPseudonymizer(
    config.INSTALL_PSEUDONYM_HMAC_KEY_BASE64,
    config.NETWORK_PSEUDONYM_HMAC_KEY_BASE64,
  );
  const app = await buildApi({
    config,
    authStore,
    apiKeyStore: new PostgresAdminApiKeyStore(postgres.pool),
    controlRepository,
    controlClient: {
      async executeWeb(actorId, envelope) {
        const snapshot = await commandService.execute({ kind: 'web', userId: actorId }, envelope);
        return snapshot.payload.revision;
      },
      async executeApiKey(keyId, envelope) {
        const snapshot = await commandService.execute({ kind: 'api-key', userId: keyId }, envelope);
        return snapshot.payload.revision;
      },
    },
    clock,
    diagnosticService,
    telemetryRepository,
    configurationShares: new PostgresConfigurationShareRepository(postgres.pool),
    configurationSharingEnabled: true,
    pseudonymizer,
  });

  try {
    const landing = await app.inject({ method: 'GET', url: '/' });
    assert.equal(landing.statusCode, 200);
    assert.equal(landing.headers['cache-control'], 'public, max-age=60, must-revalidate');
    assert.match(landing.body, /class="product-figure hero-product"/);
    assert.match(landing.body, /href="\/downloads"/);
    assert.match(landing.body, /<h1 id="hero-title">Lilac Macro<\/h1>/);
    assert.match(landing.body, /The Expeditions macro that just works/);
    assert.match(landing.body, /<h2 id="positioning-title">Quick setup, clear UI\.<\/h2>/);
    assert.match(landing.body, /<h2 id="plan-title">Automate everything<\/h2>/);
    assert.match(landing.body, /<h2 id="author-title">Configure any step<\/h2>/);
    assert.match(
      landing.body,
      /<h2 id="sessions-title">Instant RDP setup<br \/>Macro multiple accounts<\/h2>/,
    );
    assert.match(landing.body, /<h2 id="personal-title">Customizable UI color theme<\/h2>/);
    assert.match(landing.body, /<h2 id="closing-title">Ready when you are\.<\/h2>/);
    assert.doesNotMatch(landing.body, /0[1-5] \/ (?:ONE WORKSPACE|PLAN|AUTHOR|SESSIONS|YOURS)/);
    assert.doesNotMatch(landing.body, /__LILAC_DOWNLOAD_URL__/);
    assert.match(landing.body, /landing\.css\?v=firefox-mobile-1/);
    assert.doesNotMatch(landing.body, /site\.js/);
    for (const removedCopy of [
      'Roblox, the plan, runtime history, and upcoming work stay in view.',
      'Game available',
      'LilacMacro is a free passion project.',
      'WINDOWS · FREE · OPEN SOURCE',
      'Shared or separate configuration, with resolution controlled per instance.',
      'Bundled map views keep placement setup available in every local session.',
      'MAP LIBRARY',
      'PLACEMENT AUTHORING',
      'Author placements directly over the map',
      'Configure each task where it runs.',
      'Priority order is explicit. Every committed edit persists.',
      'Order matches, utilities, loops, and reset schedules without hiding the sequence.',
    ]) {
      assert.doesNotMatch(
        landing.body,
        new RegExp(removedCopy.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    }
    assert.doesNotMatch(landing.body, /loading="lazy"/);
    assert.doesNotMatch(landing.body, /id="setup"|id="safety"/);
    const landingCss = await app.inject({ method: 'GET', url: '/assets/landing.css' });
    assert.equal(landingCss.statusCode, 200);
    assert.match(landingCss.body, /grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(landingCss.body, /min-width: 0/);
    assert.doesNotMatch(landingCss.body, /min-width: 720px/);
    assert.doesNotMatch(landingCss.body, /\[data-reveal\]\.is-visible/);
    assert.match(landingCss.body, /\.landing-body \.closing \{[^}]*align-items: center;/s);
    const downloads = await app.inject({ method: 'GET', url: '/downloads' });
    assert.equal(downloads.statusCode, 200);
    assert.equal(downloads.headers['cache-control'], 'public, max-age=60, must-revalidate');
    assert.match(downloads.body, /Download Lilac Macro/);
    assert.match(downloads.body, /System Requirements/);
    assert.match(downloads.body, /Quick Start/);
    assert.match(downloads.body, /Minimum/);
    assert.match(downloads.body, /Recommended/);
    assert.doesNotMatch(
      downloads.body,
      /INSTALLER \/ TRUST|Unknown publisher|project-signed Ed25519 manifest/,
    );
    assert.match(downloads.body, /INSTALL WALKTHROUGH/);
    assert.match(downloads.body, /FIRST PLAN &amp; SETUP/);
    assert.doesNotMatch(downloads.body, /__LILAC_DOWNLOAD_URL__/);
    const downloadsCss = await app.inject({ method: 'GET', url: '/assets/downloads.css' });
    assert.equal(downloadsCss.statusCode, 200);
    assert.match(downloadsCss.body, /@media \(max-width: 620px\)/);
    assert.match(downloadsCss.body, /grid-template-columns: minmax\(0, 1fr\)/);
    const privacy = await app.inject({ method: 'GET', url: '/privacy' });
    assert.equal(privacy.statusCode, 200);
    assert.match(privacy.body, /<h1>Privacy Policy<\/h1>/);
    assert.match(privacy.body, /PRODUCT TELEMETRY/i);
    assert.match(privacy.body, /3 GiB/);
    assert.match(privacy.body, /1,000 GB/);
    assert.match(privacy.body, /90\s+days/);
    assert.doesNotMatch(privacy.body, /light report|80 MiB/i);
    const terms = await app.inject({ method: 'GET', url: '/terms' });
    assert.equal(terms.statusCode, 200);
    assert.match(terms.body, /Terms of Service/);
    assert.equal(terms.headers['cache-control'], 'public, max-age=60, must-revalidate');
    const health = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 503);
    const initializing = await app.inject({ method: 'GET', url: '/v1/control' });
    assert.equal(initializing.statusCode, 503);

    const telemetryInstallId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const telemetry = await app.inject({
      method: 'POST',
      url: '/v1/telemetry/events',
      payload: {
        installId: telemetryInstallId,
        appVersion: '1.2.3',
        privacyNoticeVersion: 5,
        events: [
          {
            kind: 'ocr-timing',
            occurredAtUtc: '2026-08-14T11:59:30.000Z',
            feature: 'ocr',
            outcome: 'completed',
            durationMilliseconds: 42,
            graphicsCapability: 'gpu',
          },
        ],
      },
    });
    assert.equal(telemetry.statusCode, 202);
    assert.equal(telemetry.headers['cache-control'], 'no-store');
    assert.deepEqual(telemetry.json(), { accepted: 1 });
    assert.equal(telemetryRepository.events.length, 1);
    assert.notEqual(telemetryRepository.events[0]?.installPseudonym, telemetryInstallId);
    assert.equal(
      telemetryRepository.events[0] && 'durationMilliseconds' in telemetryRepository.events[0]
        ? telemetryRepository.events[0].durationMilliseconds
        : null,
      42,
    );

    const formShare = await app.inject({
      method: 'POST',
      url: '/v1/shares',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'payload=Cross_site_quota_fill',
    });
    assert.equal(formShare.statusCode, 415);
    const shared = await app.inject({
      method: 'POST',
      url: '/v1/shares',
      payload: { payload: 'Abc_123-configuration' },
    });
    assert.equal(shared.statusCode, 201);
    assert.equal(shared.headers['cache-control'], 'no-store');
    assert.match(shared.json().code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{20}$/);
    const fetchedShare = await app.inject({
      method: 'POST',
      url: '/v1/shares/resolve',
      payload: { code: shared.json().code },
    });
    assert.equal(fetchedShare.statusCode, 200);
    assert.equal(fetchedShare.headers['cache-control'], 'no-store');
    assert.equal(fetchedShare.json().payload, 'Abc_123-configuration');
    const malformedShare = await app.inject({
      method: 'POST',
      url: '/v1/shares',
      payload: { payload: 'not valid payload!' },
    });
    assert.equal(malformedShare.statusCode, 400);
    for (let index = 0; index < 7; index += 1) {
      const allowedShare = await app.inject({
        method: 'POST',
        url: '/v1/shares',
        payload: { payload: `Allowed_share_${index}` },
      });
      assert.equal(allowedShare.statusCode, 201);
    }
    const rateLimitedShare = await app.inject({
      method: 'POST',
      url: '/v1/shares',
      payload: { payload: 'One_share_too_many' },
    });
    assert.equal(rateLimitedShare.statusCode, 429, rateLimitedShare.body);
    const unsafeTelemetry = await app.inject({
      method: 'POST',
      url: '/v1/telemetry/events',
      payload: {
        installId: telemetryInstallId,
        appVersion: '1.2.3',
        privacyNoticeVersion: 1,
        events: [
          {
            kind: 'operation-error',
            occurredAtUtc: '2026-08-14T11:59:30.000Z',
            feature: 'C:\\Users\\name\\secret.txt',
          },
        ],
      },
    });
    assert.equal(unsafeTelemetry.statusCode, 400);
    const poisonedTelemetry = await app.inject({
      method: 'POST',
      url: '/v1/telemetry/events',
      payload: {
        installId: telemetryInstallId,
        appVersion: '1.2.3',
        privacyNoticeVersion: 1,
        events: [
          {
            kind: 'expedition-reward-observed',
            occurredAtUtc: '2026-08-14T11:59:30.000Z',
            feature: 'route-optimizer',
            outcome: 'observed',
            material: 'AttackerControlledMaterial',
            quantity: 1,
          },
        ],
      },
    });
    assert.equal(poisonedTelemetry.statusCode, 400);
    const capacityLimitedTelemetry = await app.inject({
      method: 'POST',
      url: '/v1/telemetry/events',
      payload: {
        installId: telemetryInstallId,
        appVersion: '1.2.3',
        privacyNoticeVersion: 1,
        events: [
          {
            kind: 'feature-used',
            occurredAtUtc: '2026-08-14T11:59:30.000Z',
            feature: 'workspace',
            outcome: 'completed',
          },
        ],
      },
    });
    assert.equal(capacityLimitedTelemetry.statusCode, 429);
    assert.equal(initializing.headers['retry-after'], '30');
    assert.equal((await app.inject({ method: 'GET', url: '/admin/api/state' })).statusCode, 401);

    const sessionRaw = randomBytes(32).toString('base64url');
    await authStore.createSession(
      hashSessionToken(sessionRaw),
      '123456789012345678',
      new Date(Date.now() + 60 * 60 * 1000),
    );
    const cookie = `lm_admin=${sessionRaw}`;
    const csrf = issueCsrfToken(sessionRaw, csrfKey);
    const adminPage = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    assert.equal(adminPage.statusCode, 200);
    assert.equal(adminPage.headers['cache-control'], 'no-store');
    assert.doesNotMatch(adminPage.body, /__CSRF_TOKEN__/);
    assert.match(adminPage.body, /Runtime overview/);
    assert.match(adminPage.body, /href="\/admin\/api-keys"/);
    const diagnosticsPage = await app.inject({
      method: 'GET',
      url: '/admin/diagnostics',
      headers: { cookie },
    });
    assert.equal(diagnosticsPage.statusCode, 200);
    assert.doesNotMatch(diagnosticsPage.body, /large-upload|Large-file grant/i);
    assert.match(diagnosticsPage.body, /verified only when you request a download/);
    assert.match(diagnosticsPage.body, /\/admin\/assets\/admin\.js/);
    assert.match(diagnosticsPage.body, /\/admin\/assets\/site\.css/);
    const [adminScript, siteStyles] = await Promise.all([
      app.inject({ method: 'GET', url: '/admin/assets/admin.js', headers: { cookie } }),
      app.inject({ method: 'GET', url: '/admin/assets/site.css', headers: { cookie } }),
    ]);
    assert.match(adminScript.body, /download will start automatically when ready/);
    assert.match(siteStyles.body, /overflow-wrap: anywhere/);
    assert.match(siteStyles.body, /width: min\(520px, calc\(100vw - 32px\)\)/);
    assert.equal(adminScript.headers['cache-control'], 'no-store');
    assert.equal(siteStyles.headers['cache-control'], 'no-store');
    assert.equal(
      (await app.inject({ method: 'GET', url: '/admin/assets/admin.js' })).statusCode,
      401,
    );
    const apiKeysPage = await app.inject({
      method: 'GET',
      url: '/admin/api-keys',
      headers: { cookie },
    });
    assert.equal(apiKeysPage.statusCode, 200);
    assert.match(apiKeysPage.body, /Admin API keys/);
    assert.match(apiKeysPage.body, /diagnostics:download/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin-data' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/api/keys',
          headers: { cookie },
          payload: { name: 'Test reader', scopes: ['control:read'], expiresInDays: 30 },
        })
      ).statusCode,
      403,
    );
    const createdKey = await app.inject({
      method: 'POST',
      url: '/admin/api/keys',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Test reader', scopes: ['control:read'], expiresInDays: 30 },
    });
    assert.equal(createdKey.statusCode, 201);
    const apiToken = createdKey.json().token;
    assert.match(apiToken, /^lmk_live_/);
    const catalog = await app.inject({
      method: 'GET',
      url: '/v1/admin-data',
      headers: { authorization: `Bearer ${apiToken}` },
    });
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.headers['cache-control'], 'no-store');
    assert.deepEqual(catalog.json().resources, [
      { scope: 'control:read', href: '/v1/admin-data/control' },
    ]);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/admin-data/control',
          headers: { authorization: `Bearer ${apiToken.slice(0, -1)}x` },
        })
      ).statusCode,
      401,
    );
    const fullApiToken = await createFullAccessKey(app, cookie, csrf);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/admin-data/control',
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/admin-data/telemetry',
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).statusCode,
      401,
    );
    await assert.rejects(
      postgres.pool.query("UPDATE admin_api_key_audit SET action = 'key.created'"),
      /append-only/,
    );
    const listedKeys = await app.inject({
      method: 'GET',
      url: '/admin/api/keys',
      headers: { cookie },
    });
    assert.equal(listedKeys.statusCode, 200);
    assert.ok(listedKeys.json().some((key: { name: string }) => key.name === 'Test reader'));
    assert.equal('token' in listedKeys.json()[0], false);
    assert.equal('secretHash' in listedKeys.json()[0], false);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/api/keys/${createdKey.json().id}/revoke`,
          headers: { cookie, 'x-csrf-token': csrf },
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/admin-data/control',
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).statusCode,
      401,
    );
    const telemetrySummary = await app.inject({
      method: 'GET',
      url: '/admin/api/telemetry/summary?days=30',
      headers: { cookie },
    });
    assert.equal(telemetrySummary.statusCode, 200);
    assert.equal(telemetrySummary.json().rows[0].kind, 'ocr-timing');
    assert.equal(telemetrySummary.json().rows[0].estimatedInstallations, 1);
    assert.equal(telemetrySummary.json().rows[0].latestEventAt, '2026-08-14T11:59:30.000Z');
    await assertFullAccessTelemetry(app, fullApiToken);
    const command = {
      commandId: randomUUID(),
      expectedRevision: 0,
      command: { type: 'code.add', code: 'TESTCODE', expiresAt: null },
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/api/commands',
          headers: { cookie },
          payload: command,
        })
      ).statusCode,
      403,
    );
    const commandResponse = await app.inject({
      method: 'POST',
      url: '/admin/api/commands',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: command,
    });
    assert.equal(commandResponse.statusCode, 201);
    assert.equal(commandResponse.json().revision, 1);
    await executeFullAccessControlCommand(app, fullApiToken, 1);
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 200);
    const control = await app.inject({ method: 'GET', url: '/v1/control' });
    assert.equal(control.statusCode, 200);
    assert.equal(control.json().payload.codes[0].code, 'TESTCODE');
    assert.match(control.headers['cache-control'] ?? '', /stale-if-error=300/);

    storage.expectedBytes = 1_024;
    const create = await app.inject({
      method: 'POST',
      url: '/v1/diagnostics/uploads',
      payload: {
        installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        fileName: 'deep-debug.zip',
        sizeBytes: 1_024,
        sha256: 'a'.repeat(64),
        kind: 'deep-debug',
        explicitConsent: true,
        appVersion: '1.0.115',
      },
    });
    assert.equal(create.statusCode, 201);
    assert.equal(create.headers['cache-control'], 'no-store');
    const grant = create.json();
    assert.equal('installId' in (await diagnosticService.list())[0]!.request, false);
    assert.equal(grant.upload.kind, 'multipart');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/diagnostics/uploads/${grant.id}/parts/1`,
          headers: { authorization: `Bearer ${grant.authorizationToken}` },
          payload: { sizeBytes: 1_024, sha256: 'a'.repeat(64) },
        })
      ).statusCode,
      200,
    );
    const completion = await app.inject({
      method: 'POST',
      url: `/v1/diagnostics/uploads/${grant.id}/complete`,
      headers: { authorization: `Bearer ${grant.authorizationToken}` },
      payload: { parts: [{ partNumber: 1, etag: `"${'a'.repeat(32)}"` }] },
    });
    assert.equal(completion.statusCode, 202);
    assert.equal(completion.json().status, 'Verifying');
    const diagnostics = await app.inject({
      method: 'GET',
      url: '/admin/api/diagnostics',
      headers: { cookie },
    });
    assert.equal(diagnostics.statusCode, 200);
    assert.equal(diagnostics.json()[0].status, 'Stored');
    assert.equal(diagnostics.json()[0].verificationActive, false);
    await assertDiagnosticInstallationSearch(app, cookie, csrf, grant.id);
    await assertFullAccessDiagnosticMetadata(app, fullApiToken, grant.id);
    const downloadPath = `/admin/api/diagnostics/${grant.id}/download`;
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: downloadPath,
          headers: { cookie },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: downloadPath,
          headers: { cookie },
        })
      ).statusCode,
      403,
    );
    await requestFullAccessDiagnosticDownload(app, fullApiToken, grant.id, 202);
    const verification = await app.inject({
      method: 'POST',
      url: downloadPath,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    assert.equal(verification.statusCode, 202);
    assert.equal(verification.json().status, 'Verifying');
    assert.equal(await diagnosticService.verifyPending(), 1);
    const download = await app.inject({
      method: 'POST',
      url: downloadPath,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.json().status, 'Accepted');
    assert.equal(download.json().url, 'https://download.invalid/archive');
    await requestFullAccessDiagnosticDownload(app, fullApiToken, grant.id, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/api/diagnostics/${grant.id}/moderate`,
          headers: { cookie },
          payload: { action: 'delete' },
        })
      ).statusCode,
      403,
    );
    await deleteFullAccessDiagnostic(app, fullApiToken, grant.id, { cookie, csrf });
    assert.equal((await diagnosticService.list())[0]?.status, 'Expired');
    await diagnosticService.cleanup();
    assert.equal((await diagnosticService.list())[0]?.status, 'Deleted');

    const botCreate = await app.inject({
      method: 'POST',
      url: '/v1/diagnostics/uploads',
      payload: {
        installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        fileName: 'bot-delete.zip',
        sizeBytes: 1_024,
        sha256: 'a'.repeat(64),
        kind: 'deep-debug',
        explicitConsent: true,
        appVersion: '1.0.115',
      },
    });
    const botGrant = botCreate.json();
    await app.inject({
      method: 'POST',
      url: `/v1/diagnostics/uploads/${botGrant.id}/parts/1`,
      headers: { authorization: `Bearer ${botGrant.authorizationToken}` },
      payload: { sizeBytes: 1_024, sha256: 'a'.repeat(64) },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/diagnostics/uploads/${botGrant.id}/complete`,
      headers: { authorization: `Bearer ${botGrant.authorizationToken}` },
      payload: { parts: [{ partNumber: 1, etag: `"${'a'.repeat(32)}"` }] },
    });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/bot/diagnostics/moderate',
          payload: {
            actorId: '123456789012345678',
            uploadId: botGrant.id,
            action: 'delete',
          },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/bot/diagnostics/moderate',
          headers: { authorization: `Bearer ${config.INTERNAL_BOT_TOKEN_BASE64}` },
          payload: {
            actorId: '123456789012345678',
            uploadId: botGrant.id,
            action: 'delete',
          },
        })
      ).statusCode,
      204,
    );
    await diagnosticService.cleanup();
    assert.equal(
      (await diagnosticService.list()).filter((record) => record.status === 'Deleted').length,
      2,
    );

    await assertBrowserAudit(app, cookie);
    await assertFullAccessAudit(app, fullApiToken);

    const largeInstallId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const largeSize = 3 * 1024 ** 3 + 1;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/api/diagnostics/large-upload-grants',
          headers: { cookie },
          payload: { installId: largeInstallId, sizeBytes: largeSize, kind: 'live-debug' },
        })
      ).statusCode,
      404,
    );
    const largeRequest = {
      installId: largeInstallId,
      fileName: 'live-debug.zip',
      sizeBytes: largeSize,
      sha256: 'b'.repeat(64),
      kind: 'live-debug',
      explicitConsent: true,
      appVersion: '1.0.115',
    };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/v1/diagnostics/uploads', payload: largeRequest }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/diagnostics/uploads',
          payload: {
            ...largeRequest,
            fileName: 'installer-log.zip',
            sizeBytes: 1,
            kind: 'installer-log',
          },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
    await postgres.stop();
  }
});

test('request logging masks legacy share bearer paths', () => {
  assert.equal(
    safeRequestPath('/v1/shares/23456789ABCDEFGHJKMN?ignored=true'),
    '/v1/shares/:secret',
  );
  assert.equal(safeRequestPath('/v1/shares/resolve'), '/v1/shares/resolve');
});

test('rate-limit storage keys use rotating pseudonyms instead of source addresses', () => {
  const clock = new FixedClock(new Date('2026-08-14T12:00:00.000Z'));
  const pseudonymizer = new RotatingPseudonymizer(
    randomBytes(32).toString('base64'),
    randomBytes(32).toString('base64'),
  );
  const key = createRateLimitKeyGenerator(
    new TrustedProxyAddressResolver(['10.250.253.3/32']),
    pseudonymizer,
    clock,
  )({
    socket: { remoteAddress: '10.250.253.3' },
    headers: { 'cf-connecting-ip': '203.0.113.42' },
  } as never);

  assert.notEqual(key, '203.0.113.42');
  assert.doesNotMatch(key, /203\.0\.113\.42/);
  assert.equal(key, pseudonymizer.forNetwork('203.0.113.42', clock.now()));
});
