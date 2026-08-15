import { parseVerifyAndValidateSnapshot } from '../src/infrastructure/snapshot-signer.js';

const maximumSnapshotBytes = 256 * 1024;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function snapshotUrl(): URL {
  const value = process.env.CONTROL_SNAPSHOT_URL?.trim() ?? 'http://127.0.0.1:3100/v1/control';
  const url = new URL(value);
  const isLoopbackHttp =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if ((!isLoopbackHttp && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('CONTROL_SNAPSHOT_URL must use HTTPS or loopback HTTP without credentials.');
  }
  if (url.pathname !== '/v1/control' || url.search || url.hash) {
    throw new Error('CONTROL_SNAPSHOT_URL must identify the exact control endpoint.');
  }
  return url;
}

const response = await fetch(snapshotUrl(), {
  headers: { accept: 'application/json', 'user-agent': 'LilacMacro-Services-Contract-Probe/1' },
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error('Control snapshot request failed.');
if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
  throw new Error('Control snapshot did not use the expected media type.');
}

const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < 2 || bytes.length > maximumSnapshotBytes) {
  throw new Error('Control snapshot size was invalid.');
}

const keyId = requiredEnvironment('CONTROL_SIGNING_KEY_ID');
const publicKey = requiredEnvironment('CONTROL_SIGNING_PUBLIC_KEY_BASE64');
const snapshot = parseVerifyAndValidateSnapshot(
  JSON.parse(bytes.toString('utf8')),
  { [keyId]: publicKey },
  new Date(),
  0,
);
console.log(`Signed control snapshot verified at revision ${snapshot.payload.revision}.`);
