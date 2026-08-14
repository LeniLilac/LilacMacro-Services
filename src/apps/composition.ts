import { CommandService } from '../domain/command-service.js';
import { SystemClock } from '../domain/clock.js';
import { DiagnosticService } from '../domain/diagnostic-service.js';
import { OperationalSyncService } from '../domain/operational-sync.js';
import { PostgresAuthStore } from '../infrastructure/auth-store.js';
import { BackblazeStorage } from '../infrastructure/backblaze-storage.js';
import {
  loadConfig,
  requireApiConfig,
  requireBotConfig,
  requireControlConfig,
  requireWorkerConfig,
  type ApiServiceConfig,
  type WorkerServiceConfig,
} from '../infrastructure/config.js';
import { GitHubReleaseProbe } from '../infrastructure/github-release.js';
import { InternalApiClient } from '../infrastructure/internal-api-client.js';
import { HmacLargeUploadAuthorizer } from '../infrastructure/large-upload-authorizer.js';
import {
  PostgresControlRepository,
  PostgresDiagnosticRepository,
  createPool,
} from '../infrastructure/postgres-repositories.js';
import { RotatingPseudonymizer } from '../infrastructure/pseudonym.js';
import { RobloxPlayabilityProbe } from '../infrastructure/roblox-playability.js';
import { Ed25519SnapshotSigner } from '../infrastructure/snapshot-signer.js';
import { HmacUploadAuthorizer } from '../infrastructure/upload-authorizer.js';

export function composeApiServices() {
  const config = loadConfig();
  requireApiConfig(config);
  const pool = createPool(config.DATABASE_URL);
  const clock = new SystemClock();
  const controlRepository = new PostgresControlRepository(pool);
  const diagnosticRepository = new PostgresDiagnosticRepository(pool);
  return {
    config,
    pool,
    clock,
    controlRepository,
    diagnosticRepository,
    controlClient: new InternalApiClient(
      config.INTERNAL_CONTROL_ORIGIN,
      config.INTERNAL_API_TOKEN_BASE64,
    ),
    largeUploadAuthorizer: new HmacLargeUploadAuthorizer(config.LARGE_UPLOAD_GRANT_HMAC_KEY_BASE64),
    diagnosticService: composeDiagnosticService(
      config,
      diagnosticRepository,
      clock,
      new HmacUploadAuthorizer(config.UPLOAD_AUTH_HMAC_KEY_BASE64),
    ),
    authStore: new PostgresAuthStore(pool, config.OAUTH_STATE_ENCRYPTION_KEY_BASE64),
    pseudonymizer: new RotatingPseudonymizer(
      config.INSTALL_PSEUDONYM_HMAC_KEY_BASE64,
      config.NETWORK_PSEUDONYM_HMAC_KEY_BASE64,
    ),
  };
}

export function composeBotServices() {
  const config = loadConfig();
  requireBotConfig(config);
  return {
    config,
    control: new InternalApiClient(
      config.INTERNAL_CONTROL_ORIGIN,
      config.INTERNAL_BOT_TOKEN_BASE64,
    ),
    diagnostics: new InternalApiClient(
      config.INTERNAL_API_ORIGIN,
      config.INTERNAL_BOT_TOKEN_BASE64,
    ),
  };
}

export function composeControlServices() {
  const config = loadConfig();
  requireControlConfig(config);
  const pool = createPool(config.DATABASE_URL);
  const clock = new SystemClock();
  const controlRepository = new PostgresControlRepository(pool);
  const signer = new Ed25519SnapshotSigner(
    config.CONTROL_SIGNING_PRIVATE_KEY_BASE64,
    config.CONTROL_SIGNING_PUBLIC_KEY_BASE64,
    config.CONTROL_SIGNING_KEY_ID,
  );
  return {
    config,
    pool,
    clock,
    controlRepository,
    signer,
    commandService: new CommandService(controlRepository, signer, clock),
  };
}

export function composeWorkerServices() {
  const config = loadConfig();
  requireWorkerConfig(config);
  const pool = createPool(config.DATABASE_URL);
  const clock = new SystemClock();
  const diagnosticRepository = new PostgresDiagnosticRepository(pool);
  const control = new InternalApiClient(
    config.INTERNAL_CONTROL_ORIGIN,
    config.INTERNAL_WORKER_TOKEN_BASE64,
  );
  return {
    config,
    pool,
    clock,
    diagnosticService: composeDiagnosticService(config, diagnosticRepository, clock, null),
    control,
    operationalSync: new OperationalSyncService(
      clock,
      control,
      new GitHubReleaseProbe(config.GITHUB_RELEASE_REPOSITORY, config.GITHUB_TOKEN),
      config.ROBLOX_UNIVERSE_ID ? new RobloxPlayabilityProbe(config.ROBLOX_UNIVERSE_ID) : undefined,
    ),
  };
}

function composeDiagnosticService(
  config: ApiServiceConfig | WorkerServiceConfig,
  repository: PostgresDiagnosticRepository,
  clock: SystemClock,
  authorizer: HmacUploadAuthorizer | null,
): DiagnosticService {
  const storage = new BackblazeStorage({
    endpoint: config.BACKBLAZE_S3_ENDPOINT,
    region: config.BACKBLAZE_REGION,
    bucket: config.BACKBLAZE_BUCKET_NAME,
    keyId: config.BACKBLAZE_KEY_ID,
    applicationKey: config.BACKBLAZE_APPLICATION_KEY,
    keyPrefix: config.BACKBLAZE_KEY_PREFIX,
  });
  return new DiagnosticService(repository, storage, clock, config.BACKBLAZE_KEY_PREFIX, authorizer);
}
