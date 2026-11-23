import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { create as contentDisposition } from 'content-disposition';
import { Readable } from 'node:stream';
import type { FilesConfig } from '@tektum/grimoire-core/ports/config';
import {
  FileStorageError,
  LIST_LIMIT_MAX,
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
