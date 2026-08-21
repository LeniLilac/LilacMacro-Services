import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { multipartPartBytes, oneGiB } from '../src/contracts/diagnostics.js';
import { FixedClock } from '../src/domain/clock.js';
import { diagnosticQuotaLimits } from '../src/domain/diagnostic-policy.js';
import {
  DiagnosticService,
  verificationDeadlineMilliseconds,
  type UploadStorage,
} from '../src/domain/diagnostic-service.js';
import { MemoryDiagnosticRepository } from '../src/infrastructure/memory-repositories.js';
import { HmacUploadAuthorizer } from '../src/infrastructure/upload-authorizer.js';

class FakeStorage implements UploadStorage {
  public removed: Array<{ key: string; uploadId: string | null }> = [];
  public expectedSize = 0;
  public failRemoval = false;
  public readonly failAbortUploadIds = new Set<string>();
  public multipartUploads: Array<{ objectKey: string; uploadId: string; initiatedAt: Date }> = [];
  public async beginMultipart(): Promise<string> {
    return 'provider-upload';
  }
  public async presignPart(_key: string, _uploadId: string, part: number): Promise<string> {
    return `https://upload.invalid/part/${part}`;
  }
  public async completeMultipart(): Promise<void> {}
  public async remove(key: string, uploadId: string | null, _signal?: AbortSignal): Promise<void> {
    if (this.failRemoval) throw new Error('provider unavailable');
    this.removed.push({ key, uploadId });
  }
  public async presignDownload(): Promise<string> {
    return 'https://download.invalid/archive';
  }
  public async verifySize(_key: string, expectedBytes: number): Promise<void> {
    assert.equal(expectedBytes, this.expectedSize);
  }
  public async verifyObject(
    _key: string,
    expectedBytes: number,
    expectedSha256: string,
    _signal?: AbortSignal,
  ): Promise<void> {
    assert.equal(expectedBytes, this.expectedSize);
    assert.equal(expectedSha256, 'a'.repeat(64));
  }
  public async listMultipartUploads(): Promise<
    ReadonlyArray<{ objectKey: string; uploadId: string; initiatedAt: Date }>
  > {
    return this.multipartUploads;
  }
  public async abortMultipart(key: string, uploadId: string): Promise<void> {
    if (this.failAbortUploadIds.has(uploadId)) throw new Error('provider abort unavailable');
    this.removed.push({ key, uploadId });
  }
}

function fixture() {
  const now = new Date('2026-08-14T12:00:00.000Z');
  const repository = new MemoryDiagnosticRepository();
  const storage = new FakeStorage();
  const authorizer = new HmacUploadAuthorizer(randomBytes(32).toString('base64'));
  const clock = new FixedClock(now);
  return {
    now,
    clock,
    repository,
    storage,
    service: new DiagnosticService(repository, storage, clock, 'diagnostics/test', authorizer),
  };
}

function request(sizeBytes = 1024) {
  return {
    fileName: 'deep-debug.zip',
    sizeBytes,
    sha256: 'a'.repeat(64),
    kind: 'deep-debug' as const,
    explicitConsent: true as const,
    appVersion: '1.0.111',
  };
}

const identity = { installPseudonym: 'install', networkPseudonym: 'network' };

async function completeOnePart(
  service: DiagnosticService,
  grant: Awaited<ReturnType<DiagnosticService['create']>>,
  sizeBytes: number,
): Promise<void> {
  await service.partUrl(
    grant.id,
    1,
    { sizeBytes, sha256: 'a'.repeat(64) },
    grant.authorizationToken,
  );
  await service.complete(
    grant.id,
    [{ partNumber: 1, etag: `"${'a'.repeat(32)}"` }],
    grant.authorizationToken,
  );
}

test('global retained storage cap stays below the accepted monthly TB-hour budget', () => {
  assert.equal(diagnosticQuotaLimits.globalRetainedBytes, 1_000_000_000_000);
  const decimalTerabyteHoursPerThirtyDays =
    (diagnosticQuotaLimits.globalRetainedBytes / 1_000_000_000_000) * 30 * 24;
  assert.equal(decimalTerabyteHoursPerThirtyDays, 720);
});

test('routine upload is stored until download requests verification', async () => {
  const { service, repository, storage } = fixture();
  storage.expectedSize = 1024;
  const grant = await service.create(identity, request());
  assert.equal('installId' in (await repository.find(grant.id))!.request, false);
  assert.equal(grant.upload.kind, 'multipart');
  await assert.rejects(service.complete(grant.id, [], 'wrong'), /authorization failed/);
  await completeOnePart(service, grant, 1024);
  assert.equal((await repository.find(grant.id))?.status, 'Pending');
  assert.deepEqual(
    repository.audit.slice(0, 2).map((event) => event.action),
    ['upload.created', 'upload.completed'],
  );
  assert.equal(await service.verifyPending(), 0);
  assert.deepEqual(await service.requestDownload(grant.id, { kind: 'web', userId: '123' }), {
    status: 'Verifying',
  });
  assert.equal(
    repository.audit.filter((event) => event.action === 'verification.requested').length,
    1,
  );
  assert.equal(await service.verifyPending(), 1);
  assert.equal((await repository.find(grant.id))?.status, 'Accepted');
  assert.equal(
    await service.downloadUrl(grant.id, { kind: 'web', userId: '123' }),
    'https://download.invalid/archive',
  );
  assert.ok(repository.audit.some((event) => event.action === 'download.requested'));
});

test('the single archive limit accepts exactly 3 GiB and rejects anything larger', async () => {
  const { service, repository, storage } = fixture();
  const size = 3 * oneGiB;
  storage.expectedSize = size;
  await assert.rejects(
    service.create(identity, request(size + 1)),
    /Too big|less than or equal to 3 GiB/,
  );
  const grant = await service.create(identity, request(size));
  assert.equal(grant.upload.kind, 'multipart');
  if (grant.upload.kind !== 'multipart') return;
  const last = grant.upload.partCount;
  assert.equal(grant.upload.partSizeBytes, multipartPartBytes);
  for (let partNumber = 1; partNumber <= last; partNumber += 1) {
    const preceding = (partNumber - 1) * multipartPartBytes;
    const sizeBytes = Math.min(multipartPartBytes, size - preceding);
    assert.match(
      await service.partUrl(
        grant.id,
        partNumber,
        { sizeBytes, sha256: 'b'.repeat(64) },
        grant.authorizationToken,
      ),
      /part/,
    );
  }
  await assert.rejects(
    service.partUrl(
      grant.id,
      last + 1,
      { sizeBytes: 1, sha256: 'b'.repeat(64) },
      grant.authorizationToken,
    ),
    /outside/,
  );
  const parts = Array.from({ length: last }, (_, index) => ({
    partNumber: index + 1,
    etag: `"${'a'.repeat(32)}"`,
  }));
  await service.complete(grant.id, parts, grant.authorizationToken);
  assert.equal((await repository.find(grant.id))?.status, 'Pending');
  await service.requestDownload(grant.id, { kind: 'web', userId: '123' });
  assert.equal(await service.verifyPending(), 1);
  const record = await repository.find(grant.id);
  assert.equal(record?.status, 'Accepted');
});

test('administrator can delete an accepted archive and repeated deletion is idempotent', async () => {
  const { service, repository, storage } = fixture();
  storage.expectedSize = 1024;
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);
  await service.requestDownload(grant.id, { kind: 'web', userId: '123' });
  await service.verifyPending();

  await service.moderate(grant.id, { kind: 'web', userId: '123' }, 'delete');
  assert.equal((await repository.find(grant.id))?.status, 'Expired');
  await service.cleanup();
  assert.equal((await repository.find(grant.id))?.status, 'Deleted');
  assert.deepEqual(storage.removed, [
    { key: (await repository.find(grant.id))?.objectKey, uploadId: null },
  ]);
  assert.ok(repository.audit.some((event) => event.action === 'moderation.delete'));
  assert.ok(
    repository.audit.some(
      (event) =>
        event.action === 'deletion.succeeded' &&
        event.details.reason === 'retention-or-lifecycle-deadline',
    ),
  );

  await service.moderate(grant.id, { kind: 'web', userId: '123' }, 'delete');
  assert.equal(storage.removed.length, 1);
});

test('administrator deletion failure remains queued for cleanup retry', async () => {
  const { service, repository, storage, clock } = fixture();
  storage.expectedSize = 1024;
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);
  await service.requestDownload(grant.id, { kind: 'web', userId: '123' });
  await service.verifyPending();
  storage.failRemoval = true;

  await service.moderate(grant.id, { kind: 'discord', userId: '123' }, 'delete');
  await service.cleanup();
  assert.equal((await repository.find(grant.id))?.status, 'Failed');
  assert.ok(repository.audit.some((event) => event.action === 'deletion.retry-scheduled'));

  storage.failRemoval = false;
  clock.advance(60_000);
  assert.equal(await service.cleanup(), 1);
  assert.equal((await repository.find(grant.id))?.status, 'Deleted');
});

test('quota reserves atomically before requesting provider storage', async () => {
  const { service, storage } = fixture();
  const first = await service.create(identity, request());
  const second = await service.create(identity, { ...request(), fileName: 'second.zip' });
  assert.ok(first.id && second.id);
  await assert.rejects(
    service.create(identity, { ...request(), fileName: 'third.zip' }),
    /quota was exceeded/,
  );
  assert.equal(storage.removed.length, 0);
});

test('multipart creation compensates when provider state cannot be persisted', async () => {
  const { service, repository, storage } = fixture();
  repository.setProviderUploadId = async () => false;
  await assert.rejects(service.create(identity, request(3 * oneGiB)), /lifecycle changed/);
  assert.equal(storage.removed.length, 1);
  assert.equal(storage.removed[0]?.uploadId, 'provider-upload');
});

test('failed multipart compensation is retained in immutable audit for reconciliation', async () => {
  const { service, repository, storage } = fixture();
  repository.setProviderUploadId = async () => false;
  storage.failAbortUploadIds.add('provider-upload');
  await assert.rejects(service.create(identity, request(3 * oneGiB)), /lifecycle changed/);
  assert.ok(repository.audit.some((event) => event.action === 'multipart.compensation-failed'));
});

test('multipart reconciliation aborts only stale uploads absent from repository state', async () => {
  const { service, storage, now } = fixture();
  const grant = await service.create(identity, request(3 * oneGiB));
  assert.equal(grant.upload.kind, 'multipart');
  storage.multipartUploads = [
    {
      objectKey: 'diagnostics/test/2026/08/referenced.zip',
      uploadId: 'provider-upload',
      initiatedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    },
    {
      objectKey: 'diagnostics/test/2026/08/orphan.zip',
      uploadId: 'orphan-upload',
      initiatedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    },
    {
      objectKey: 'diagnostics/test/2026/08/recent.zip',
      uploadId: 'recent-upload',
      initiatedAt: new Date(now.getTime() - 60_000),
    },
  ];
  assert.equal(await service.reconcileMultipartOrphans(), 1);
  assert.deepEqual(storage.removed.at(-1), {
    key: 'diagnostics/test/2026/08/orphan.zip',
    uploadId: 'orphan-upload',
  });
});

test('multipart reconciliation continues after one provider abort fails', async () => {
  const { service, storage, now } = fixture();
  storage.failAbortUploadIds.add('blocked-upload');
  storage.multipartUploads = [
    {
      objectKey: 'diagnostics/test/2026/08/blocked.zip',
      uploadId: 'blocked-upload',
      initiatedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    },
    {
      objectKey: 'diagnostics/test/2026/08/removable.zip',
      uploadId: 'removable-upload',
      initiatedAt: new Date(now.getTime() - 13 * 60 * 60 * 1000),
    },
  ];

  await assert.rejects(service.reconcileMultipartOrphans(), /provider abort unavailable/);
  assert.deepEqual(storage.removed, [
    {
      key: 'diagnostics/test/2026/08/removable.zip',
      uploadId: 'removable-upload',
    },
  ]);
});

test('verification has a size-bounded deadline and a finite retry lifetime', async () => {
  const { repository, storage, clock } = fixture();
  const service = new DiagnosticService(
    repository,
    storage,
    clock,
    'diagnostics/test',
    new HmacUploadAuthorizer(randomBytes(32).toString('base64')),
    () => 5,
  );
  storage.expectedSize = 1024;
  storage.verifyObject = async (_key, _bytes, _sha256, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);
  await service.requestDownload(grant.id, { kind: 'web', userId: '123' });
  assert.equal(await service.verifyPending(), 1);
  assert.equal((await repository.find(grant.id))?.verificationAttempts, 1);

  storage.verifyObject = async () => {
    throw new Error('provider unavailable');
  };
  for (let attempt = 1; attempt < 8; attempt += 1) {
    clock.advance(60 * 60 * 1000);
    assert.equal(await service.verifyPending(), 1);
  }
  assert.equal((await repository.find(grant.id))?.status, 'Expired');
  assert.equal(await service.cleanup(), 1);
  assert.equal((await repository.find(grant.id))?.status, 'Deleted');

  assert.equal(verificationDeadlineMilliseconds(1), 10 * 60 * 1000);
  assert.equal(verificationDeadlineMilliseconds(30 * oneGiB), 6_444_000);
  assert.equal(verificationDeadlineMilliseconds(100 * oneGiB), 2 * 60 * 60 * 1000);
});

test('worker shutdown cancels active verification and requeues it immediately', async () => {
  const { service, repository, storage } = fixture();
  storage.expectedSize = 1024;
  let announceStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  storage.verifyObject = async (_key, _bytes, _sha256, signal) =>
    new Promise<void>((_resolve, reject) => {
      announceStarted?.();
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);
  await service.requestDownload(grant.id, { kind: 'web', userId: '123' });
  const controller = new AbortController();
  const verification = service.verifyPending(1, controller.signal);
  await started;
  controller.abort();
  assert.equal(await verification, 1);
  const record = await repository.find(grant.id);
  assert.equal(record?.status, 'Verifying');
  assert.equal(record?.verificationAttempts, 1);
  assert.ok(record?.nextVerificationAttemptAt);
});

test('worker shutdown cancels integrity-failure deletion and schedules its retry', async () => {
  const { service, repository, storage } = fixture();
  storage.expectedSize = 1024;
  storage.verifyObject = async () => {
    throw new Error('Diagnostic upload integrity SHA-256 mismatch.');
  };
  let announceRemovalStarted: (() => void) | undefined;
  const removalStarted = new Promise<void>((resolve) => {
    announceRemovalStarted = resolve;
  });
  storage.remove = async (_key, _uploadId, signal) =>
    new Promise<void>((_resolve, reject) => {
      announceRemovalStarted?.();
      assert.ok(signal, 'integrity-failure deletion must receive the worker signal');
      const abort = () => reject(new Error('aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);
  await service.requestDownload(grant.id, { kind: 'web', userId: '123' });
  const controller = new AbortController();
  const verification = service.verifyPending(1, controller.signal);
  await removalStarted;
  controller.abort();
  await assert.rejects(verification, /aborted/);
  const record = await repository.find(grant.id);
  assert.equal(record?.status, 'Failed');
  assert.equal(record?.deletionAttempts, 1);
  assert.ok(record?.nextDeletionAttemptAt);
});

test('cleanup backs off failed provider deletion without reporting deletion', async () => {
  const { service, repository, storage, clock } = fixture();
  const grant = await service.create(identity, request());
  await repository.transition(grant.id, ['Uploading'], 'Accepted', {
    expiresAt: new Date('2026-08-14T11:00:00.000Z'),
  });
  storage.failRemoval = true;
  assert.equal(await service.cleanup(), 1);
  assert.equal((await repository.find(grant.id))?.status, 'Failed');
  storage.failRemoval = false;
  assert.equal(await service.cleanup(), 0);
  clock.advance(60_000);
  assert.equal(await service.cleanup(), 1);
  assert.equal((await repository.find(grant.id))?.status, 'Deleted');
  assert.ok(repository.audit.some((event) => event.action === 'deletion.retry-scheduled'));
  assert.ok(repository.audit.some((event) => event.action === 'deletion.succeeded'));
});

test('full-object mismatch is audited and deleted before acceptance', async () => {
  const { service, repository, storage } = fixture();
  storage.expectedSize = 1024;
  storage.verifyObject = async () => {
    throw new Error('Diagnostic upload integrity SHA-256 mismatch.');
  };
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);
  await service.requestDownload(grant.id, { kind: 'web', userId: '123' });
  assert.equal(await service.verifyPending(), 1);
  assert.equal((await repository.find(grant.id))?.status, 'Invalid');
  assert.ok(repository.audit.some((event) => event.action === 'verification.failed'));
  assert.ok(repository.audit.some((event) => event.action === 'deletion.succeeded'));
  assert.equal(storage.removed.length, 1);
});

test('untouched stored uploads expire without full-object verification', async () => {
  const { service, repository, storage, clock } = fixture();
  storage.expectedSize = 1024;
  let verificationCalls = 0;
  storage.verifyObject = async () => {
    verificationCalls += 1;
  };
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);

  assert.equal(await service.verifyPending(), 0);
  clock.advance(73 * 60 * 60 * 1000);
  assert.equal(await service.cleanup(), 1);
  assert.equal((await repository.find(grant.id))?.status, 'Deleted');
  assert.equal(verificationCalls, 0);
});

test('download verification request is idempotent and excludes legacy Pending records', async () => {
  const { service, repository, storage, now } = fixture();
  storage.expectedSize = 1024;
  const grant = await service.create(identity, request());
  await completeOnePart(service, grant, 1024);
  const actor = { kind: 'web' as const, userId: '123' };

  assert.deepEqual(
    await Promise.all([
      service.requestDownload(grant.id, actor),
      service.requestDownload(grant.id, actor),
    ]),
    [{ status: 'Verifying' }, { status: 'Verifying' }],
  );
  assert.equal(
    repository.audit.filter((event) => event.action === 'verification.requested').length,
    1,
  );

  const legacy = await service.create(
    { installPseudonym: 'legacy-install', networkPseudonym: 'legacy-network' },
    { ...request(), fileName: 'legacy.zip' },
  );
  await repository.transition(legacy.id, ['Uploading'], 'Pending', {
    acceptanceDeadline: new Date(now.getTime() + 60_000),
  });
  await assert.rejects(service.requestDownload(legacy.id, actor), /unavailable for download/);
});
