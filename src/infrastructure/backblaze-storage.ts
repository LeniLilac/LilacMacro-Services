import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { UploadStorage } from '../domain/diagnostic-service.js';
import type { MultipartPartGrant } from '../contracts/diagnostics.js';

export interface BackblazeOptions {
  endpoint: string;
  region: string;
  bucket: string;
  keyId: string;
  applicationKey: string;
  keyPrefix: string;
}

const providerControlTimeoutMilliseconds = 60_000;
const multipartCompletionTimeoutMilliseconds = 5 * 60_000;
const fallbackObjectVerificationTimeoutMilliseconds = 2 * 60 * 60_000;
const uploadGrantLifetimeSeconds = 60 * 60;

export class BackblazeStorage implements UploadStorage {
  private readonly client: S3Client;

  public constructor(private readonly options: BackblazeOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.keyId, secretAccessKey: options.applicationKey },
      forcePathStyle: false,
    });
  }

  public async beginMultipart(objectKey: string, contentType: string): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: this.safeKey(objectKey),
        ContentType: contentType,
        ChecksumAlgorithm: 'SHA256',
        ServerSideEncryption: 'AES256',
      }),
      { abortSignal: AbortSignal.timeout(providerControlTimeoutMilliseconds) },
    );
    if (!response.UploadId) throw new Error('Backblaze did not return a multipart upload ID.');
    return response.UploadId;
  }

  public async presignPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    grant: MultipartPartGrant,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.options.bucket,
        Key: this.safeKey(objectKey),
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: grant.sizeBytes,
        ChecksumSHA256: Buffer.from(grant.sha256, 'hex').toString('base64'),
      }),
      {
        expiresIn: uploadGrantLifetimeSeconds,
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    );
  }

  public async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; etag: string; checksumSha256: string }>,
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: this.safeKey(objectKey),
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
            ChecksumSHA256: Buffer.from(part.checksumSha256, 'hex').toString('base64'),
          })),
        },
      }),
      { abortSignal: AbortSignal.timeout(multipartCompletionTimeoutMilliseconds) },
    );
  }

  public async remove(
    objectKey: string,
    uploadId: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = this.safeKey(objectKey);
    let abortError: unknown;
    if (uploadId) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.options.bucket,
            Key: key,
            UploadId: uploadId,
          }),
          { abortSignal: providerSignal(signal, providerControlTimeoutMilliseconds) },
        );
      } catch (error) {
        if (!isMissingUpload(error)) abortError = error;
      }
    }
    await this.deleteEveryVersion(key, signal);
    if (abortError) throw abortError;
  }

  public async listMultipartUploads(
    prefix: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<{ objectKey: string; uploadId: string; initiatedAt: Date }>> {
    if (prefix !== this.options.keyPrefix || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Multipart reconciliation scope was invalid.');
    }
    const response = await this.client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.options.bucket,
        Prefix: `${prefix}/`,
        MaxUploads: limit,
      }),
      { abortSignal: providerSignal(signal, providerControlTimeoutMilliseconds) },
    );
    return (response.Uploads ?? []).flatMap((upload) => {
      if (!upload.Key || !upload.UploadId || !upload.Initiated) return [];
      return [
        {
          objectKey: this.safeKey(upload.Key),
          uploadId: upload.UploadId,
          initiatedAt: new Date(upload.Initiated),
        },
      ];
    });
  }

  public async abortMultipart(
    objectKey: string,
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!uploadId || uploadId.length > 1_024) {
      throw new Error('Multipart upload ID was invalid.');
    }
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: this.safeKey(objectKey),
        UploadId: uploadId,
      }),
      { abortSignal: providerSignal(signal, providerControlTimeoutMilliseconds) },
    );
  }

  public async presignDownload(objectKey: string, fileName: string): Promise<string> {
    const safeName = fileName.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 160);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: this.safeKey(objectKey),
        ResponseContentType: 'application/zip',
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: 5 * 60 },
    );
  }

  public async verifySize(objectKey: string, expectedBytes: number): Promise<void> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.safeKey(objectKey) }),
      { abortSignal: AbortSignal.timeout(providerControlTimeoutMilliseconds) },
    );
    if (response.ContentLength !== expectedBytes) {
      throw new Error('Diagnostic upload size verification failed.');
    }
  }

  public async verifyObject(
    objectKey: string,
    expectedBytes: number,
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: this.safeKey(objectKey),
    });
    const effectiveSignal =
      signal ?? AbortSignal.timeout(fallbackObjectVerificationTimeoutMilliseconds);
    const response = await this.client.send(command, { abortSignal: effectiveSignal });
    if (!response.Body) throw new Error('Diagnostic upload integrity body was unavailable.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      if (effectiveSignal.aborted) throw new Error('Diagnostic verification timed out.');
      bytes += chunk.byteLength;
      if (bytes > expectedBytes) {
        throw new Error('Diagnostic upload integrity size mismatch.');
      }
      hash.update(chunk);
    }
    if (bytes !== expectedBytes) throw new Error('Diagnostic upload integrity size mismatch.');
    if (hash.digest('hex').toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error('Diagnostic upload integrity SHA-256 mismatch.');
    }
  }

  private safeKey(value: string): string {
    const expectedPrefix = `${this.options.keyPrefix}/`;
    if (
      !value.startsWith(expectedPrefix) ||
      !/^[A-Za-z0-9/_-]+\.zip$/.test(value) ||
      value.includes('..') ||
      value.startsWith('/')
    ) {
      throw new Error('Object key was outside the diagnostic prefix.');
    }
    return value;
  }

  private async deleteEveryVersion(key: string, signal?: AbortSignal): Promise<void> {
    const versions = await this.listEveryVersion(key, signal);
    for (let offset = 0; offset < versions.length; offset += 1_000) {
      const response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.options.bucket,
          Delete: { Objects: versions.slice(offset, offset + 1_000), Quiet: true },
        }),
        { abortSignal: providerSignal(signal, providerControlTimeoutMilliseconds) },
      );
      if (response.Errors?.length) {
        throw new Error('Backblaze did not delete every diagnostic object version.');
      }
    }
    if ((await this.listEveryVersion(key, signal)).length !== 0) {
      throw new Error('Backblaze retained a diagnostic object version after deletion.');
    }
  }

  private async listEveryVersion(
    key: string,
    signal?: AbortSignal,
  ): Promise<Array<{ Key: string; VersionId: string }>> {
    const versions: Array<{ Key: string; VersionId: string }> = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.options.bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
          MaxKeys: 1_000,
        }),
        { abortSignal: providerSignal(signal, providerControlTimeoutMilliseconds) },
      );
      for (const version of [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]) {
        if (version.Key !== key) continue;
        if (!version.VersionId) throw new Error('Backblaze object version ID was unavailable.');
        versions.push({ Key: key, VersionId: version.VersionId });
      }
      if (!response.IsTruncated) return versions;
      if (!response.NextKeyMarker || !response.NextVersionIdMarker) {
        throw new Error('Backblaze object-version pagination was incomplete.');
      }
      keyMarker = response.NextKeyMarker;
      versionIdMarker = response.NextVersionIdMarker;
    }
    throw new Error('Backblaze object-version listing exceeded its page limit.');
  }
}

function providerSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function isMissingUpload(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  return [candidate.name, candidate.Code, candidate.code].includes('NoSuchUpload');
}
