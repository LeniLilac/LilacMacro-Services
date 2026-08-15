import { spawn } from 'node:child_process';
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  type GetBucketLifecycleConfigurationOutput,
  type LifecycleRule,
} from '@aws-sdk/client-s3';

interface AuthorizationResponse {
  accountId: string;
  authorizationToken: string;
  apiInfo: {
    storageApi: {
      apiUrl: string;
      allowed: { capabilities: string[] };
    };
  };
}

interface CreatedKey {
  applicationKeyId: string;
  applicationKey: string;
}

interface KeyPlan {
  label: string;
  idSecret: string;
  keySecret: string;
  capabilities: string[];
}

const bucketId = required('BACKBLAZEBUCKETID');
const bucketName = required('BACKBLAZEBUCKETNAME');
const prefix = required('BACKBLAZE_KEY_PREFIX').replace(/\/+$/, '');
if (!/^[A-Za-z0-9/_-]{1,180}$/.test(prefix) || prefix.includes('..')) {
  throw new Error('Backblaze diagnostic prefix is unsafe.');
}
if (!process.env.DOPPLER_TOKEN) throw new Error('DOPPLER_TOKEN is required.');

const authorization = await authorize(
  required('BACKBLAZEMASTERKEYID'),
  required('BACKBLAZEMASTERKEYTOKEN'),
);
for (const capability of ['writeKeys', 'deleteKeys', 'listBuckets']) {
  if (!authorization.apiInfo.storageApi.allowed.capabilities.includes(capability)) {
    throw new Error(`Backblaze provisioning authority lacks ${capability}.`);
  }
}
await assertPrivateBucket(authorization);
await configureLifecycle();

const plans: KeyPlan[] = [
  {
    label: 'api',
    idSecret: 'BACKBLAZE_API_KEY_ID',
    keySecret: 'BACKBLAZE_API_APPLICATION_KEY',
    capabilities: ['readFiles', 'writeFiles'],
  },
  {
    label: 'worker',
    idSecret: 'BACKBLAZE_WORKER_KEY_ID',
    keySecret: 'BACKBLAZE_WORKER_APPLICATION_KEY',
    capabilities: ['deleteFiles', 'listFiles', 'readFiles', 'writeFiles'],
  },
];

for (const plan of plans) {
  const existingId = process.env[plan.idSecret];
  const existingKey = process.env[plan.keySecret];
  if (Boolean(existingId) !== Boolean(existingKey)) {
    throw new Error(`${plan.label} Backblaze key configuration is incomplete.`);
  }
  if (existingId && existingKey) {
    console.error(`Backblaze ${plan.label} key is already configured.`);
    continue;
  }

  const created = await createKey(authorization, plan);
  try {
    await storeDopplerSecret(plan.idSecret, created.applicationKeyId);
    await storeDopplerSecret(plan.keySecret, created.applicationKey);
  } catch {
    await Promise.allSettled([
      deleteKey(authorization, created.applicationKeyId),
      deleteDopplerSecrets([plan.idSecret, plan.keySecret]),
    ]);
    throw new Error(`Backblaze ${plan.label} key could not be stored safely.`);
  }
  console.error(`Backblaze ${plan.label} key was created and stored in Doppler.`);
}

async function authorize(keyId: string, applicationKey: string): Promise<AuthorizationResponse> {
  const response = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: {
      authorization: `Basic ${Buffer.from(`${keyId}:${applicationKey}`).toString('base64')}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Backblaze provisioning authorization failed.');
  const payload = (await response.json()) as AuthorizationResponse;
  validateApiUrl(payload.apiInfo.storageApi.apiUrl);
  return payload;
}

async function createKey(authorization: AuthorizationResponse, plan: KeyPlan): Promise<CreatedKey> {
  const response = await fetch(
    `${authorization.apiInfo.storageApi.apiUrl}/b2api/v4/b2_create_key`,
    {
      method: 'POST',
      headers: {
        authorization: authorization.authorizationToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accountId: authorization.accountId,
        capabilities: plan.capabilities,
        keyName: `lilacmacro-${plan.label}-production`,
        bucketIds: [bucketId],
        namePrefix: `${prefix}/`,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`Backblaze rejected the ${plan.label} key plan.`);
  const created = (await response.json()) as CreatedKey;
  if (!created.applicationKeyId || !created.applicationKey) {
    throw new Error('Backblaze omitted the newly created application key.');
  }
  return created;
}

async function assertPrivateBucket(authorization: AuthorizationResponse): Promise<void> {
  const response = await fetch(
    `${authorization.apiInfo.storageApi.apiUrl}/b2api/v4/b2_list_buckets`,
    {
      method: 'POST',
      headers: {
        authorization: authorization.authorizationToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ accountId: authorization.accountId, bucketId }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error('Backblaze bucket privacy verification failed.');
  const payload = (await response.json()) as {
    buckets?: Array<{ bucketId?: string; bucketName?: string; bucketType?: string }>;
  };
  const bucket = payload.buckets?.[0];
  if (
    payload.buckets?.length !== 1 ||
    bucket?.bucketId !== bucketId ||
    bucket.bucketName !== bucketName ||
    bucket.bucketType !== 'allPrivate'
  ) {
    throw new Error('Backblaze diagnostic bucket must be the exact configured private bucket.');
  }
}

async function configureLifecycle(): Promise<void> {
  const client = new S3Client({
    endpoint: required('BACKBLAZES3ENDPOINT'),
    region: required('BACKBLAZEREGION'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: required('BACKBLAZEBUCKETKEYID'),
      secretAccessKey: required('BACKBLAZEBUCKETKEY'),
    },
  });
  const id = 'lilacmacro-diagnostics-retention-v1';
  const expected: LifecycleRule = {
    ID: id,
    Status: 'Enabled',
    Filter: { Prefix: `${prefix}/` },
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  };
  let current: GetBucketLifecycleConfigurationOutput | null = null;
  try {
    current = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NoSuchLifecycleConfiguration') throw error;
  }
  const rules = [...(current?.Rules ?? []).filter((rule) => rule.ID !== id), expected];
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucketName,
      LifecycleConfiguration: { Rules: rules },
    }),
  );
  const verified = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }),
  );
  const rule = verified.Rules?.find((candidate) => candidate.ID === id);
  if (
    rule?.Status !== 'Enabled' ||
    rule.Filter?.Prefix !== `${prefix}/` ||
    rule.NoncurrentVersionExpiration?.NoncurrentDays !== 1 ||
    rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== 1
  ) {
    throw new Error('Backblaze diagnostic lifecycle policy did not verify after provisioning.');
  }
}

async function deleteKey(
  authorization: AuthorizationResponse,
  applicationKeyId: string,
): Promise<void> {
  const response = await fetch(
    `${authorization.apiInfo.storageApi.apiUrl}/b2api/v4/b2_delete_key`,
    {
      method: 'POST',
      headers: {
        authorization: authorization.authorizationToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ applicationKeyId }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error('Backblaze key rollback failed.');
}

async function storeDopplerSecret(name: string, value: string): Promise<void> {
  await runDoppler(['secrets', 'set', name, '--no-interactive', '--silent'], value);
}

async function deleteDopplerSecrets(names: string[]): Promise<void> {
  await runDoppler(['secrets', 'delete', ...names, '--yes', '--silent']);
}

async function runDoppler(arguments_: string[], input?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('doppler', arguments_, {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Doppler rejected a secret update.')),
    );
    child.stdin.end(input);
  });
}

function validateApiUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !/^api\d+\.backblazeb2\.com$/i.test(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Backblaze returned an unsafe API endpoint.');
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
