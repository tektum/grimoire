import type { Clock } from '../ports/clock.js';
import {
  FileStorageError,
  LIST_LIMIT_MAX,
  assertValidKey,
  type ByteStream,
  type FileStorage,
} from '../ports/file-storage.js';

/** The two create-only request headers a store can be told to honour (the header is a setting). */
export const CREATE_ONLY_HEADERS = {
  'if-none-match': '*',
  'x-goog-if-generation-match': '0',
} as const;
export type CreateOnlyHeader = keyof typeof CREATE_ONLY_HEADERS;

export interface FakeFileStorageOptions {
  clock?: Clock;
  createOnlyHeader?: CreateOnlyHeader;
}

/** What a signed URL was asked for, recorded so a test can assert on it. */
export type SignedRequest =
  | {
      kind: 'upload';
      url: string;
      key: string;
      size: number;
      contentType: string;
      ifNoneMatch: boolean;
      disposition?: 'attachment';
      createOnlyHeader: CreateOnlyHeader;
      expiresAt: number;
    }
  | {
      kind: 'download';
      url: string;
      key: string;
      disposition: 'inline' | 'attachment';
      fileName?: string;
      contentType?: string;
      expiresAt: number;
    };

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
  modifiedAt: number;
}

const ORIGIN = 'https://fake.invalid/';

async function collect(body: ByteStream | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice();
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** In-memory FileStorage: bytes in memory, signed URLs on `fake.invalid`, expiry on the injected clock. */
export class FakeFileStorage implements FileStorage {
  readonly signed: SignedRequest[] = [];
  private readonly objects = new Map<string, StoredObject>();
  private readonly clock: Clock;
  private readonly createOnlyHeader: CreateOnlyHeader;
  private counter = 0;

  constructor(options: FakeFileStorageOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.createOnlyHeader = options.createOnlyHeader ?? 'if-none-match';
  }

  private find(key: string): StoredObject {
    assertValidKey(key);
    const found = this.objects.get(key);
    if (!found) throw new FileStorageError('not-found', 'no such object');
    return found;
  }

  async head(key: string): Promise<{
    size: number;
    contentType: string;
    etag: string;
    modifiedAt: number;
  }> {
    const { bytes, contentType, etag, modifiedAt } = this.find(key);
    return { size: bytes.length, contentType, etag, modifiedAt };
  }

  /** `size` is the length of the returned body (the whole object without a range). */
  async get(
    key: string,
    o: { range?: { start: number; end: number } } = {},
  ): Promise<{ body: ByteStream; size: number; contentType: string }> {
    const { bytes, contentType } = this.find(key);
    let slice = bytes;
    if (o.range) {
      const { start, end } = o.range;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= bytes.length) {
        throw new FileStorageError('range-not-satisfiable', 'the range lies outside the object');
      }
      slice = bytes.slice(start, Math.min(end, bytes.length - 1) + 1);
    }
    const copy = slice.slice();
    return {
      body: (async function* () {
        yield copy;
      })(),
      size: copy.length,
      contentType,
    };
  }

  async put(
    key: string,
    body: ByteStream | Uint8Array,
    o: { size: number; contentType: string; ifNoneMatch?: boolean },
  ): Promise<{ etag: string }> {
    assertValidKey(key);
    const bytes = await collect(body);
    // No await between this check and the write below: the check and the write are one step.
    if (o.ifNoneMatch && this.objects.has(key)) {
      throw new FileStorageError('already-exists', 'the object exists and the put is create-only');
    }
    if (bytes.length !== o.size) throw new FileStorageError('unavailable', 'the body is not the declared size');
    this.counter += 1;
    const etag = `"fake-${this.counter}"`;
    this.objects.set(key, {
      bytes,
      contentType: o.contentType,
      etag,
      modifiedAt: this.clock.now(),
    });
    return { etag };
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    this.objects.delete(key);
  }

  async list(
    prefix: string,
    o: { cursor?: string; limit?: number } = {},
  ): Promise<{
    items: { key: string; size: number; modifiedAt: number }[];
    nextCursor: string | null;
  }> {
    const limit = Math.min(Math.max(Math.trunc(o.limit ?? LIST_LIMIT_MAX), 1), LIST_LIMIT_MAX);
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && (o.cursor === undefined || key > o.cursor))
      .sort();
    const page = keys.slice(0, limit).map((key) => {
      const { bytes, modifiedAt } = this.objects.get(key) as StoredObject;
      return { key, size: bytes.length, modifiedAt };
    });
    return {
      items: page,
      nextCursor: keys.length > limit ? (page[page.length - 1]?.key ?? null) : null,
    };
  }

  async signUpload(
    key: string,
    o: {
      size: number;
      contentType: string;
      ttlSeconds: number;
      disposition?: 'attachment';
      ifNoneMatch?: boolean;
    },
  ): Promise<{
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: number;
  }> {
    assertValidKey(key);
    const expiresAt = this.clock.now() + o.ttlSeconds * 1000;
    const url = `${ORIGIN}${key}?${new URLSearchParams({
      op: 'upload',
      size: String(o.size),
      type: o.contentType,
      expires: String(expiresAt),
      sig: String((this.counter += 1)),
    }).toString()}`;
    const headers: Record<string, string> = { 'content-type': o.contentType };
    if (o.ifNoneMatch) headers[this.createOnlyHeader] = CREATE_ONLY_HEADERS[this.createOnlyHeader];
    if (o.disposition) headers['content-disposition'] = o.disposition;
    this.signed.push({
      kind: 'upload',
      url,
      key,
      size: o.size,
      contentType: o.contentType,
      ifNoneMatch: o.ifNoneMatch === true,
      ...(o.disposition ? { disposition: o.disposition } : {}),
      createOnlyHeader: this.createOnlyHeader,
      expiresAt,
    });
    return { method: 'PUT', url, headers, expiresAt };
  }

  async signDownload(
    key: string,
    o: {
      ttlSeconds: number;
      disposition: 'inline' | 'attachment';
      fileName?: string;
      contentType?: string;
    },
  ): Promise<{ url: string; expiresAt: number }> {
    assertValidKey(key);
    const expiresAt = this.clock.now() + o.ttlSeconds * 1000;
    const params = new URLSearchParams({
      op: 'download',
      disposition: o.disposition,
    });
    if (o.fileName !== undefined) params.set('fileName', o.fileName);
    if (o.contentType !== undefined) params.set('type', o.contentType);
    params.set('expires', String(expiresAt));
    params.set('sig', String((this.counter += 1)));
    const url = `${ORIGIN}${key}?${params.toString()}`;
    this.signed.push({
      kind: 'download',
      url,
      key,
      disposition: o.disposition,
      ...(o.fileName !== undefined ? { fileName: o.fileName } : {}),
      ...(o.contentType !== undefined ? { contentType: o.contentType } : {}),
      expiresAt,
    });
    return { url, expiresAt };
  }

  /**
   * What the browser does with a signed upload: sends `body` with `headers` to `url`. Refused once the clock has
   * passed the expiry, when the size or type differ from what was signed, and, for a create-only signature,
   * when the store's create-only header is missing, and with `already-exists` when the key exists. A create-only header
   * the signature did not ask for, or the store's other header, has no effect.
   */
  async receiveSignedUpload(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void> {
    const request = this.signed.find((entry) => entry.kind === 'upload' && entry.url === url);
    if (request?.kind !== 'upload') throw new FileStorageError('unavailable', 'the signature is unknown');
    if (this.clock.now() >= request.expiresAt) throw new FileStorageError('unavailable', 'the signature has expired');
    const sent = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    if (body.length !== request.size) throw new FileStorageError('unavailable', 'the size is not the signed size');
    if (sent['content-type'] !== request.contentType) {
      throw new FileStorageError('unavailable', 'the type is not the signed type');
    }
    if (request.disposition && sent['content-disposition'] !== request.disposition) {
      throw new FileStorageError('unavailable', 'the signed content-disposition header is missing');
    }
    const header = request.createOnlyHeader;
    if (request.ifNoneMatch && sent[header] !== CREATE_ONLY_HEADERS[header]) {
      throw new FileStorageError('unavailable', 'the signed create-only header is missing');
    }
    await this.put(request.key, body, {
      size: request.size,
      contentType: request.contentType,
      ifNoneMatch: request.ifNoneMatch,
    });
  }
}
