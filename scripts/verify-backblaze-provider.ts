import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { checksumHeaderValue } from '../src/domain/diagnostic-service.js';
import {
  BackblazeStorage,
  type BackblazeOptions,
} from '../src/infrastructure/backblaze-storage.js';

const requiredNames = [
  'BACKBLAZEBUCKETID',
  'BACKBLAZEBUCKETNAME',
  'BACKBLAZES3ENDPOINT',
  'BACKBLAZEREGION',
  'BACKBLAZE_API_KEY_ID',
  'BACKBLAZE_API_APPLICATION_KEY',
  'BACKBLAZE_WORKER_KEY_ID',
  'BACKBLAZE_WORKER_APPLICATION_KEY',
  'BACKBLAZE_KEY_PREFIX',
] as const;
for (const name of requiredNames) {
  if (!process.env[name]) throw new Error(`Required provider input ${name} is unavailable.`);
}

const environment = process.env as NodeJS.ProcessEnv &
  Record<(typeof requiredNames)[number], string>;
const prefix = environment.BACKBLAZE_KEY_PREFIX.replace(/\/+$/, '');
if (!/^[A-Za-z0-9/_-]{1,180}$/.test(prefix) || prefix.includes('..')) {
  throw new Error('Backblaze diagnostic prefix is unsafe.');
}
if (environment.BACKBLAZE_API_KEY_ID === environment.BACKBLAZE_WORKER_KEY_ID) {
  throw new Error('Backblaze API and worker keys must be distinct.');
}

const shared: Omit<BackblazeOptions, 'keyId' | 'applicationKey'> = {
  endpoint: environment.BACKBLAZES3ENDPOINT,
  region: environment.BACKBLAZEREGION,
  bucket: environment.BACKBLAZEBUCKETNAME,
  keyPrefix: prefix,
};
const apiStorage = new BackblazeStorage({
  ...shared,
  keyId: environment.BACKBLAZE_API_KEY_ID,
  applicationKey: environment.BACKBLAZE_API_APPLICATION_KEY,
});
const workerStorage = new BackblazeStorage({
  ...shared,
  keyId: environment.BACKBLAZE_WORKER_KEY_ID,
  applicationKey: environment.BACKBLAZE_WORKER_APPLICATION_KEY,
});

const apiCapabilities = ['readFiles', 'writeFiles'];
const workerCapabilities = ['deleteFiles', 'listFiles', 'readFiles', 'writeFiles'];
await assertKeyScope(
  environment.BACKBLAZE_API_KEY_ID,
  environment.BACKBLAZE_API_APPLICATION_KEY,
  apiCapabilities,
);
await assertKeyScope(
  environment.BACKBLAZE_WORKER_KEY_ID,
  environment.BACKBLAZE_WORKER_APPLICATION_KEY,
  workerCapabilities,
);

await apiStorage.listMultipartUploads(prefix, 1).then(
  () => {
    throw new Error('Backblaze API key unexpectedly listed multipart uploads.');
  },
  () => undefined,
);

const run = randomUUID().replaceAll('-', '');
const keysToRemove = new Set<string>();
const multipartToAbort = new Map<string, string>();
try {
  const invalidMultipartKey = key('invalid-multipart');
  const invalidUploadId = await apiStorage.beginMultipart(invalidMultipartKey, 'application/zip');
  multipartToAbort.set(invalidMultipartKey, invalidUploadId);
  const invalidPart = randomBytes(5 * 1024 * 1024);
  const invalidPartSha256 = digest(invalidPart);
  const invalidGrant = { sizeBytes: invalidPart.byteLength, sha256: invalidPartSha256 };
  await requireRejected(
    await put(
      await apiStorage.presignPart(invalidMultipartKey, invalidUploadId, 1, invalidGrant),
      invalidPart.subarray(0, invalidPart.byteLength - 1),
      { 'x-amz-checksum-sha256': checksumHeaderValue(invalidPartSha256) },
    ),
    'Wrong-length multipart part',
  );
  const corruptPart = Buffer.from(invalidPart);
  corruptPart[0] = (corruptPart[0] ?? 0) ^ 0xff;
  await requireRejected(
    await put(
      await apiStorage.presignPart(invalidMultipartKey, invalidUploadId, 1, invalidGrant),
      corruptPart,
      { 'x-amz-checksum-sha256': checksumHeaderValue(invalidPartSha256) },
    ),
    'Wrong-checksum multipart part',
  );
  await workerStorage.abortMultipart(invalidMultipartKey, invalidUploadId);
  multipartToAbort.delete(invalidMultipartKey);

  const partOne = randomBytes(5 * 1024 * 1024);
  const partTwo = randomBytes(1024 * 1024);
  const multipartKey = key('multipart');
  const uploadId = await apiStorage.beginMultipart(multipartKey, 'application/zip');
  multipartToAbort.set(multipartKey, uploadId);
  const completedParts: Array<{
    partNumber: number;
    etag: string;
    checksumSha256: string;
  }> = [];
  let replayUrl = '';
  for (const [index, part] of [partOne, partTwo].entries()) {
    const sha256 = digest(part);
    const partUrl = await apiStorage.presignPart(multipartKey, uploadId, index + 1, {
      sizeBytes: part.byteLength,
      sha256,
    });
    replayUrl = partUrl;
    const response = await put(partUrl, part, {
      'x-amz-checksum-sha256': checksumHeaderValue(sha256),
    });
    await requireSuccess(response, `Correct multipart part ${index + 1}`);
    const etag = response.headers.get('etag');
    if (!etag) throw new Error('Backblaze omitted the multipart ETag.');
    completedParts.push({ partNumber: index + 1, etag, checksumSha256: sha256 });
  }
  await apiStorage.completeMultipart(multipartKey, uploadId, completedParts);
  multipartToAbort.delete(multipartKey);
  keysToRemove.add(multipartKey);
  const combined = Buffer.concat([partOne, partTwo]);
  await apiStorage.verifySize(multipartKey, combined.byteLength);
  await workerStorage.verifyObject(multipartKey, combined.byteLength, digest(combined));
  await requireRejected(
    await put(replayUrl, partTwo, {
      'x-amz-checksum-sha256': checksumHeaderValue(digest(partTwo)),
    }),
    'Completed multipart part replay',
  );

  const replacement = randomBytes(5 * 1024 * 1024);
  const replacementSha256 = digest(replacement);
  const replacementUploadId = await apiStorage.beginMultipart(multipartKey, 'application/zip');
  multipartToAbort.set(multipartKey, replacementUploadId);
  const replacementResponse = await put(
    await apiStorage.presignPart(multipartKey, replacementUploadId, 1, {
      sizeBytes: replacement.byteLength,
      sha256: replacementSha256,
    }),
    replacement,
    { 'x-amz-checksum-sha256': checksumHeaderValue(replacementSha256) },
  );
  await requireSuccess(replacementResponse, 'Second object version multipart part');
  const replacementEtag = replacementResponse.headers.get('etag');
  if (!replacementEtag) throw new Error('Backblaze omitted the replacement multipart ETag.');
  await apiStorage.completeMultipart(multipartKey, replacementUploadId, [
    {
      partNumber: 1,
      etag: replacementEtag,
      checksumSha256: replacementSha256,
    },
  ]);
  multipartToAbort.delete(multipartKey);
  await workerStorage.verifyObject(multipartKey, replacement.byteLength, replacementSha256);

  const orphanKey = key('orphan');
  const orphanId = await apiStorage.beginMultipart(orphanKey, 'application/zip');
  multipartToAbort.set(orphanKey, orphanId);
  const listed = await workerStorage.listMultipartUploads(prefix, 500);
  if (!listed.some((entry) => entry.objectKey === orphanKey && entry.uploadId === orphanId)) {
    throw new Error('Backblaze omitted a live multipart upload from worker reconciliation.');
  }
  await workerStorage.abortMultipart(orphanKey, orphanId);
  multipartToAbort.delete(orphanKey);

  for (const objectKey of keysToRemove) await workerStorage.remove(objectKey, null);
  keysToRemove.clear();
  console.log(
    'Backblaze process scopes, multipart constraints, replay rejection, full-version cleanup, and reconciliation passed.',
  );
} finally {
  await Promise.allSettled(
    [...multipartToAbort].map(([objectKey, uploadId]) =>
      workerStorage.abortMultipart(objectKey, uploadId),
    ),
  );
  await Promise.allSettled(
    [...keysToRemove].map((objectKey) => workerStorage.remove(objectKey, null)),
  );
}

function key(label: string): string {
  return `${prefix}/provider-check/${run}-${label}.zip`;
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function put(
  url: string,
  body: Uint8Array,
  requiredHeaders: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    headers: {
      ...requiredHeaders,
      'content-length': String(body.byteLength),
    },
    body: Uint8Array.from(body).buffer,
    signal: AbortSignal.timeout(60_000),
  });
}

async function requireSuccess(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  await response.arrayBuffer();
  throw new Error(`${label} failed with HTTP ${response.status}.`);
}

async function requireRejected(response: Response, label: string): Promise<void> {
  if (response.ok) throw new Error(`${label} was unexpectedly accepted by Backblaze.`);
  await response.arrayBuffer();
}

async function assertKeyScope(
  keyId: string,
  applicationKey: string,
  expectedCapabilities: ReadonlyArray<string>,
): Promise<void> {
  const authorization = Buffer.from(`${keyId}:${applicationKey}`).toString('base64');
  const response = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { authorization: `Basic ${authorization}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Backblaze process key authorization failed.');
  const payload = (await response.json()) as {
    apiInfo?: {
      storageApi?: {
        allowed?: {
          buckets?: Array<{ id?: string }>;
          capabilities?: string[];
          namePrefix?: string | null;
        };
      };
    };
  };
  const allowed = payload.apiInfo?.storageApi?.allowed;
  const actualCapabilities = [...(allowed?.capabilities ?? [])].sort();
  const capabilities = [...expectedCapabilities].sort();
  if (
    JSON.stringify(actualCapabilities) !== JSON.stringify(capabilities) ||
    allowed?.namePrefix !== `${prefix}/` ||
    allowed?.buckets?.length !== 1 ||
    allowed.buckets[0]?.id !== environment.BACKBLAZEBUCKETID
  ) {
    throw new Error('Backblaze process key scope did not match the required least authority.');
  }
}
