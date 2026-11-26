import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { create as contentDisposition } from 'content-disposition';
import { Readable } from 'node:stream';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import {
  FileStorageError,
  LIST_LIMIT_MAX,
  MAX_PARTS,
  MIN_PART_BYTES,
  assertValidKey,
  type ByteStream,
  type FileStorage,
} from '@tektum/grimoire-core/ports/file-storage';
import { createClients } from './client.js';
import { mapError } from './errors.js';

export interface FileStorageOptions {
  /** Milliseconds since the epoch; only for `expiresAt` of signed URLs. */
  readonly now?: () => number;
  /** Attempts the internal client makes per request, retries included (the SDK default when unset). */
  readonly maxAttempts?: number;
}

const OCTET_STREAM = 'application/octet-stream';

/** The value that makes a request create-only, for the header the setting names. */
const createOnlyValue = (header: string): string => (header === 'if-none-match' ? '*' : '0');

/** Adds one request header while the command is built, so that it is signed with the rest. */
function withHeader<C extends { middlewareStack: PutObjectCommand['middlewareStack'] }>(
  command: C,
  name: string,
  value: string,
): C {
  command.middlewareStack.add(
    (next) => async (args) => {
      (args.request as { headers: Record<string, string> }).headers[name] = value;
      return next(args);
    },
    { step: 'build', name: `header-${name}` },
  );
  return command;
}

/** A name for the header: control characters (line breaks above all) never reach it. */
const headerSafeName = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, '_');

/** The file store behind the port, over the S3 protocol. */
export class S3FileStorage implements FileStorage {
  readonly client: S3Client;
  /** Bound to the public endpoint; used only for signing. */
  readonly signer: S3Client;
  private readonly bucket: string;
  private readonly now: () => number;

  constructor(
    readonly config: FilesConfig,
    options: FileStorageOptions = {},
  ) {
    ({ client: this.client, signer: this.signer } = createClients(config, options));
    this.bucket = config.bucket;
    this.now = options.now ?? Date.now;
  }

  private async send<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw mapError(error);
    }
  }

  async head(key: string): Promise<{ size: number; contentType: string; etag: string; modifiedAt: number }> {
    assertValidKey(key);
    const out = await this.send(() => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })));
    return {
      size: out.ContentLength ?? 0,
      contentType: out.ContentType ?? OCTET_STREAM,
      etag: out.ETag ?? '',
      modifiedAt: out.LastModified?.getTime() ?? 0,
    };
  }

  /** `size` is the length of the returned body: the whole object, or the range. */
  async get(
    key: string,
    o: { range?: { start: number; end: number } } = {},
  ): Promise<{ body: ByteStream; size: number; contentType: string }> {
    assertValidKey(key);
    let range: string | undefined;
    if (o.range) {
      const { start, end } = o.range;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        throw new FileStorageError('range-not-satisfiable', 'the range is not valid');
      }
      range = `bytes=${start}-${end}`;
    }
    const out = await this.send(() =>
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: range } : {}) })),
    );
    if (!out.Body) throw new FileStorageError('unavailable', 'the file store sent no body');
    return {
      body: out.Body as unknown as ByteStream,
      size: out.ContentLength ?? 0,
      contentType: out.ContentType ?? OCTET_STREAM,
    };
  }

  async put(
    key: string,
    body: ByteStream | Uint8Array,
    o: { size: number; contentType: string; ifNoneMatch?: boolean },
  ): Promise<{ etag: string }> {
    assertValidKey(key);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body instanceof Uint8Array ? body : Readable.from(body),
      ContentLength: o.size,
      ContentType: o.contentType,
    });
    if (o.ifNoneMatch) withHeader(command, this.config.createOnlyHeader, createOnlyValue(this.config.createOnlyHeader));
    const out = await this.send(() => this.client.send(command));
    return { etag: out.ETag ?? '' };
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.kind !== 'not-found') throw mapped;
    }
  }

  async list(
    prefix: string,
    o: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: { key: string; size: number; modifiedAt: number }[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(o.limit ?? LIST_LIMIT_MAX), 1), LIST_LIMIT_MAX);
    const out = await this.send(() =>
      this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: limit,
          ...(o.cursor === undefined ? {} : { ContinuationToken: o.cursor }),
        }),
      ),
    );
    return {
      items: (out.Contents ?? []).map((item) => ({
        key: item.Key ?? '',
        size: item.Size ?? 0,
        modifiedAt: item.LastModified?.getTime() ?? 0,
      })),
      nextCursor: out.IsTruncated ? (out.NextContinuationToken ?? null) : null,
    };
  }

  /**
   * The signature covers the headers the browser must send as they are: the type, the length (set by the browser from
   * the body), the create-only header when asked for and the disposition when asked for. The SDK's default would
   * sign the host alone, and the store would then accept any of them changed.
   */
  async signUpload(
    key: string,
    o: {
      size: number;
      contentType: string;
      ttlSeconds: number;
      disposition?: 'attachment';
      ifNoneMatch?: boolean;
    },
  ): Promise<{ method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: number }> {
    assertValidKey(key);
    const createOnly = this.config.createOnlyHeader;
    const headers: Record<string, string> = { 'content-type': o.contentType };
    const signable = new Set(['content-type', 'content-length']);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: o.contentType,
      ContentLength: o.size,
      ...(o.disposition ? { ContentDisposition: o.disposition } : {}),
    });
    if (o.disposition) {
      headers['content-disposition'] = o.disposition;
      signable.add('content-disposition');
    }
    if (o.ifNoneMatch) {
      headers[createOnly] = createOnlyValue(createOnly);
      signable.add(createOnly);
      withHeader(command, createOnly, headers[createOnly]);
    }
    const url = await this.send(() =>
      getSignedUrl(this.signer, command, { expiresIn: o.ttlSeconds, signableHeaders: signable }),
    );
    return { method: 'PUT', url, headers, expiresAt: this.now() + o.ttlSeconds * 1000 };
  }

  async createMultipart(key: string, o: { contentType: string }): Promise<{ uploadId: string }> {
    assertValidKey(key);
    const out = await this.send(() =>
      this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: o.contentType })),
    );
    if (!out.UploadId) throw new FileStorageError('unavailable', 'the file store opened no upload');
    return { uploadId: out.UploadId };
  }

  /** The length is signed with the part, so the store takes exactly `size` bytes for exactly this part number and upload. */
  async signPart(
    key: string,
    o: { uploadId: string; partNumber: number; size: number; ttlSeconds: number },
  ): Promise<{ method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: number }> {
    assertValidKey(key);
    if (!Number.isInteger(o.partNumber) || o.partNumber < 1 || o.partNumber > MAX_PARTS) {
      throw new FileStorageError('invalid-parts', 'the part number is outside 1 to 10000');
    }
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: o.uploadId,
      PartNumber: o.partNumber,
      ContentLength: o.size,
    });
    const url = await this.send(() =>
      getSignedUrl(this.signer, command, { expiresIn: o.ttlSeconds, signableHeaders: new Set(['content-length']) }),
    );
    return { method: 'PUT', url, headers: {}, expiresAt: this.now() + o.ttlSeconds * 1000 };
  }

  /** Every part the store holds, in order (a page is at most 1000 parts). */
  private async parts(key: string, uploadId: string): Promise<{ partNumber: number; size: number; etag: string }[]> {
    assertValidKey(key);
    // One entry per part number: S3 lists a part sent twice once, the development store (SeaweedFS) lists both, in no order that tells which is newer. A part sent again carries the same bytes (the port's rule), so any copy will do.
    const all = new Map<number, { partNumber: number; size: number; etag: string }>();
    let marker: string | undefined;
    do {
      const out = await this.send(() =>
        this.client.send(
          new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MaxParts: 1000, ...(marker === undefined ? {} : { PartNumberMarker: marker }) }),
        ),
      );
      for (const part of out.Parts ?? []) all.set(part.PartNumber ?? 0, { partNumber: part.PartNumber ?? 0, size: part.Size ?? 0, etag: part.ETag ?? '' });
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return [...all.values()].sort((a, b) => a.partNumber - b.partNumber);
  }

  async listParts(key: string, uploadId: string): Promise<{ partNumber: number; size: number }[]> {
    return (await this.parts(key, uploadId)).map(({ partNumber, size }) => ({ partNumber, size }));
  }

  /** The parts are read from the store, never taken from the caller, so the ETags stay here and the object is what was uploaded. */
  async completeMultipart(key: string, uploadId: string): Promise<{ etag: string; size: number }> {
    const parts = await this.parts(key, uploadId);
    if (parts.length === 0 || parts.some((p, i) => p.partNumber !== i + 1)) {
      throw new FileStorageError('invalid-parts', 'the parts are not numbered 1 to n without a gap');
    }
    if (parts.slice(0, -1).some((p) => p.size < MIN_PART_BYTES)) {
      throw new FileStorageError('invalid-parts', 'a part but the last is under the minimum size');
    }
    const out = await this.send(() =>
      this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      ),
    );
    return { etag: out.ETag ?? '', size: parts.reduce((sum, p) => sum + p.size, 0) };
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    assertValidKey(key);
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (error) {
      const mapped = mapError(error);
      if (mapped.kind !== 'not-found') throw mapped;
    }
  }

  async signDownload(
    key: string,
    o: { ttlSeconds: number; disposition: 'inline' | 'attachment'; fileName?: string; contentType?: string },
  ): Promise<{ url: string; expiresAt: number }> {
    assertValidKey(key);
    const disposition = contentDisposition(o.fileName === undefined ? undefined : headerSafeName(o.fileName), {
      type: o.disposition,
    });
    const url = await this.send(() =>
      getSignedUrl(
        this.signer,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseContentDisposition: disposition,
          ...(o.contentType === undefined ? {} : { ResponseContentType: o.contentType }),
          ResponseCacheControl: 'private, no-store',
        }),
        { expiresIn: o.ttlSeconds },
      ),
    );
    return { url, expiresAt: this.now() + o.ttlSeconds * 1000 };
  }
}
