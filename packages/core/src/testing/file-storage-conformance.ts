import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  FileStorageError,
  type ByteStream,
  type FileStorage,
  MIN_PART_BYTES,
  type FileStorageErrorKind,
} from '../ports/file-storage.js';

/** The request header that makes an upload create-only (a setting of the store). */
export type CreateOnlyHeader = 'if-none-match' | 'x-goog-if-generation-match';

/**
 * What a store can and cannot do in the test set-up. A case that needs a capability the store lacks is reported as
 * skipped with the capability's name, never left out. `realExpiry` says whether `harness.advance` lets real time
 * pass (the fake moves an injected clock instead); the cases run either way.
 */
export interface FileStorageCapabilities {
  readonly cors: boolean;
  readonly anonymousDenied: boolean;
  readonly realExpiry: boolean;
  readonly flatMemory: boolean;
  /** The store refuses a signed upload whose signed headers the client changed or dropped. */
  readonly signedHeadersEnforced: boolean;
  readonly createOnlyHeader: CreateOnlyHeader;
}

export type FileStorageFlag = {
  [K in keyof FileStorageCapabilities]: FileStorageCapabilities[K] extends boolean ? K : never;
}[keyof FileStorageCapabilities];

export interface SignedRequest {
  readonly method: 'GET' | 'PUT' | 'OPTIONS';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array;
}

export interface SignedResponse {
  readonly status: number;
  /** Header names in lower case. */
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

/** What a case needs besides the store: the browser's side of a signed URL, and the passing of time. */
export interface FileStorageHarness {
  readonly store: FileStorage;
  readonly capabilities: FileStorageCapabilities;
  /** The scheme and host every signed URL must start with (no trailing slash). */
  readonly publicOrigin: string;
  /** Sends what an HTTP client would send; never throws for a refusal, it answers a status. */
  send(request: SignedRequest): Promise<SignedResponse>;
  /** Lets `seconds` pass for signed URLs: the fake moves its clock, a real store waits. */
  advance(seconds: number): Promise<void>;
  /** An origin the store's CORS rule allows (the browser's side of `cors-preflight`); a made-up one when unset. */
  readonly corsOrigin?: string;
  /**
   * Runs a garbage collection when the runtime can. The memory case calls it while streaming, so that buffers that
   * are only waiting to be collected are not mistaken for buffers the store holds on to.
   */
  collectGarbage?(): void;
  /** A URL to the object without any signature. */
  unsignedUrl(key: string): string;
}

export interface FileStorageCase {
  readonly name: string;
  /** The capability that must be true for the case to run. */
  readonly requires?: FileStorageFlag;
  run(h: FileStorageHarness): Promise<void>;
}

/** A new key under a prefix no other case uses, so that cases never see each other's objects. */
export const freshPrefix = (): string => `conformance/${randomUUID()}`;

/** `length` bytes of a repeating pattern, so that a wrong slice shows up as different bytes. */
export function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 7 + (i >> 8)) & 0xff;
  return out;
}

export async function readAll(body: ByteStream): Promise<Uint8Array> {
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

export async function expectKind(kind: FileStorageErrorKind, action: Promise<unknown>, what: string): Promise<void> {
  try {
    await action;
  } catch (error) {
    assert.ok(error instanceof FileStorageError, `${what}: expected a FileStorageError, got ${String(error)}`);
    assert.equal(error.kind, kind, what);
    return;
  }
  assert.fail(`${what}: expected ${kind}, but nothing was thrown`);
}

const binary = 'application/octet-stream';
const createOnlyValue = (header: CreateOnlyHeader): string => (header === 'if-none-match' ? '*' : '0');
const isSuccess = (status: number): boolean => status >= 200 && status < 300;

export const fileStorageConformance: readonly FileStorageCase[] = [
  {
    name: 'put-head-get',
    async run({ store }) {
      const key = `${freshPrefix()}/a`;
      const bytes = patternBytes(600);
      const { etag } = await store.put(key, bytes, { size: bytes.length, contentType: 'image/png' });
      assert.ok(etag.length > 0, 'put returns an etag');
      const head = await store.head(key);
      assert.equal(head.size, 600);
      assert.equal(head.contentType, 'image/png');
      assert.equal(head.etag, etag);
      assert.ok(Number.isFinite(head.modifiedAt) && head.modifiedAt > 0, 'modifiedAt is a time in milliseconds');
      const got = await store.get(key);
      assert.equal(got.size, 600);
      assert.equal(got.contentType, 'image/png');
      assert.deepEqual(await readAll(got.body), bytes);
    },
  },
  {
    name: 'range-first-512',
    async run({ store }) {
      const key = `${freshPrefix()}/a`;
      const bytes = patternBytes(2048);
      await store.put(key, bytes, { size: bytes.length, contentType: binary });
      const got = await store.get(key, { range: { start: 0, end: 511 } });
      assert.deepEqual(await readAll(got.body), bytes.slice(0, 512));
      assert.equal(got.size, 512, 'size is the length of the returned body');
    },
  },
  {
    name: 'range-middle',
    async run({ store }) {
      const key = `${freshPrefix()}/a`;
      const bytes = patternBytes(4096);
      await store.put(key, bytes, { size: bytes.length, contentType: binary });
      const got = await store.get(key, { range: { start: 1000, end: 1999 } });
      assert.deepEqual(await readAll(got.body), bytes.slice(1000, 2000), 'the end of a range is inclusive');
      assert.equal(got.size, 1000, 'size is the length of the returned body');
    },
  },
  {
    name: 'range-past-end',
    async run({ store }) {
      const key = `${freshPrefix()}/a`;
      await store.put(key, patternBytes(100), { size: 100, contentType: binary });
      await expectKind(
        'range-not-satisfiable',
        store.get(key, { range: { start: 100, end: 199 } }),
        'start at the size',
      );
      await expectKind(
        'range-not-satisfiable',
        store.get(key, { range: { start: 5000, end: 5001 } }),
        'start far past',
      );
    },
  },
  {
    name: 'get-absent',
    async run({ store }) {
      const key = `${freshPrefix()}/absent`;
      await expectKind('not-found', store.get(key), 'get');
      await expectKind('not-found', store.head(key), 'head');
    },
  },
  {
    name: 'delete-absent',
    async run({ store }) {
      const key = `${freshPrefix()}/a`;
      await store.delete(key);
      await store.put(key, patternBytes(3), { size: 3, contentType: binary });
      await store.delete(key);
      await store.delete(key);
      await expectKind('not-found', store.head(key), 'head after delete');
    },
  },
  {
    name: 'list-paging',
    async run({ store }) {
      const prefix = freshPrefix();
      const names = ['d', 'a', 'c', 'e', 'b'];
      for (const name of names) await store.put(`${prefix}/${name}`, patternBytes(4), { size: 4, contentType: binary });
      await store.put(`${prefix}-other/z`, patternBytes(4), { size: 4, contentType: binary });
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.list(`${prefix}/`, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
        assert.ok(page.items.length <= 2, 'a page holds at most the limit');
        for (const item of page.items) {
          assert.equal(item.size, 4);
          assert.ok(item.modifiedAt > 0);
          seen.push(item.key);
        }
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        assert.ok(pages <= 10, 'paging ends');
      } while (cursor !== undefined);
      assert.deepEqual(
        seen,
        ['a', 'b', 'c', 'd', 'e'].map((name) => `${prefix}/${name}`),
        'ascending, once each, prefix only',
      );
      assert.deepEqual((await store.list(`${prefix}/`)).items.length, 5, 'the default limit holds them all');
    },
  },
  {
    name: 'key-validation',
    async run({ store }) {
      const prefix = freshPrefix();
      const bad = [
        '',
        `${prefix}//b`,
        `${prefix}/./b`,
        `${prefix}/../b`,
        `/${prefix}`,
        `${prefix}/`,
        `${prefix}\\b`,
        `${prefix}/\u0000b`,
        `${prefix}/a\nb`,
        `${prefix}/a\u007fb`,
        `${prefix}/a\u0085b`,
        `${prefix}/a\ud800b`,
        `${prefix}/a\udc00b`,
        `${prefix}/..`,
        `${prefix}/${'a'.repeat(513)}`,
        `${prefix}/${'a'.repeat(256)}`, // one segment over 255 bytes
        `${prefix}/${'\u00e9'.repeat(300)}`, // over 512 UTF-8 bytes, under 512 UTF-16 units
      ];
      for (const key of bad) {
        const shown = JSON.stringify(key.slice(-20));
        await expectKind('invalid-key', store.head(key), `head ${shown}`);
        await expectKind('invalid-key', store.get(key), `get ${shown}`);
        await expectKind('invalid-key', store.delete(key), `delete ${shown}`);
        await expectKind(
          'invalid-key',
          store.put(key, patternBytes(1), { size: 1, contentType: binary }),
          `put ${shown}`,
        );
      }
      // A key of 512 bytes is valid when no segment passes 200 bytes; a single segment of 256 bytes is not.
      const segments: string[] = [];
      for (let left = 512 - prefix.length - 1; left > 0; left -= 201) segments.push('a'.repeat(Math.min(200, left)));
      const longest = `${prefix}/${segments.join('/')}`;
      assert.equal(new TextEncoder().encode(longest).length, 512, 'the key under test is 512 bytes');
      await store.put(longest, patternBytes(1), { size: 1, contentType: binary });
      assert.equal((await store.head(longest)).size, 1);
      await store.delete(longest);
      // A percent-encoded dot segment is either refused (invalid-key) or kept as a literal name; whichever it does,
      // it must never reach the plain key, on a write, a read or a delete.
      const variants = [
        { escaped: `${prefix}/%2e/x`, target: `${prefix}/x` },
        { escaped: `${prefix}/%2E/x`, target: `${prefix}/x` },
        { escaped: `${prefix}/p/q/%2e%2e/x`, target: `${prefix}/p/x` },
      ];
      const refusal = (what: string) => (error: unknown) => {
        assert.ok(error instanceof FileStorageError, `${what}: ${String(error)}`);
        assert.ok(['invalid-key', 'not-found'].includes(error.kind), `${what}: got ${error.kind}`);
        return null;
      };
      for (const { escaped, target } of variants) {
        const seeded = patternBytes(7);
        await store.put(target, seeded, { size: 7, contentType: binary });
        // A write either succeeds as a literal name or is refused with invalid-key; nothing else.
        await store.put(escaped, patternBytes(9), { size: 9, contentType: binary }).catch((error: unknown) => {
          assert.ok(
            error instanceof FileStorageError && error.kind === 'invalid-key',
            `put ${escaped}: ${String(error)}`,
          );
        });
        assert.deepEqual(
          await readAll((await store.get(target)).body),
          seeded,
          `put ${escaped} must not reach ${target}`,
        );
        const head = await store.head(escaped).catch(refusal(`head ${escaped}`));
        if (head !== null) assert.equal(head.size, 9, `head ${escaped} must not describe ${target}`);
        const read = await store.get(escaped).then((got) => readAll(got.body), refusal(`get ${escaped}`));
        assert.notDeepEqual(read, seeded, `get ${escaped} must not read ${target}`);
        await store.delete(escaped).catch((error: unknown) => {
          assert.ok(error instanceof FileStorageError && error.kind === 'invalid-key', `delete ${escaped}`);
        });
        assert.deepEqual(
          await readAll((await store.get(target)).body),
          seeded,
          `delete ${escaped} must not touch ${target}`,
        );
      }
    },
  },
  {
    name: 'put-conditional-412',
    async run({ store }) {
      const key = `${freshPrefix()}/a`;
      const first = patternBytes(10);
      await store.put(key, first, { size: 10, contentType: binary, ifNoneMatch: true });
      await expectKind(
        'already-exists',
        store.put(key, patternBytes(20), { size: 20, contentType: binary, ifNoneMatch: true }),
        'second conditional put',
      );
      assert.deepEqual(
        await readAll((await store.get(key)).body),
        first,
        'the refused put leaves the object unchanged',
      );
      const second = patternBytes(20);
      await store.put(key, second, { size: 20, contentType: binary });
      assert.deepEqual(await readAll((await store.get(key)).body), second, 'an unconditional put overwrites');
    },
  },
  {
    name: 'sign-upload-exact',
    async run({ store, send, capabilities }) {
      const key = `${freshPrefix()}/a`;
      const bytes = patternBytes(300);
      const signed = await store.signUpload(key, {
        size: 300,
        contentType: 'image/png',
        ttlSeconds: 600,
        ifNoneMatch: true,
      });
      assert.equal(signed.method, 'PUT');
      assert.ok(signed.expiresAt > 0 && Number.isFinite(signed.expiresAt), 'expiresAt is a time in milliseconds');
      assert.equal(signed.headers['content-type'], 'image/png');
      assert.equal(signed.headers[capabilities.createOnlyHeader], createOnlyValue(capabilities.createOnlyHeader));
      assert.equal(signed.headers['content-disposition'], undefined, 'no disposition was asked for');
      const sent = await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: bytes });
      assert.ok(isSuccess(sent.status), `the exact upload is accepted, got ${sent.status}`);
      const head = await store.head(key);
      assert.equal(head.size, 300);
      assert.equal(head.contentType, 'image/png');
      assert.deepEqual(await readAll((await store.get(key)).body), bytes);
      const attachment = await store.signUpload(key, {
        size: 1,
        contentType: binary,
        ttlSeconds: 60,
        disposition: 'attachment',
      });
      assert.equal(attachment.headers['content-disposition'], 'attachment');
    },
  },
  {
    name: 'sign-upload-wrong-size',
    async run({ store, send }) {
      const key = `${freshPrefix()}/a`;
      const signed = await store.signUpload(key, { size: 10, contentType: binary, ttlSeconds: 600 });
      for (const length of [11, 9, 0]) {
        const sent = await send({
          method: 'PUT',
          url: signed.url,
          headers: signed.headers,
          body: patternBytes(length),
        });
        assert.ok(
          !isSuccess(sent.status),
          `a body of ${length} bytes for a signed size of 10 is refused, got ${sent.status}`,
        );
        await expectKind('not-found', store.head(key), `the key stays absent after ${length} bytes`);
      }
    },
  },
  {
    name: 'sign-upload-wrong-type',
    async run({ store, send }) {
      const key = `${freshPrefix()}/a`;
      const signed = await store.signUpload(key, { size: 10, contentType: 'image/png', ttlSeconds: 600 });
      const headers = { ...signed.headers, 'content-type': 'text/html' };
      const sent = await send({ method: 'PUT', url: signed.url, headers, body: patternBytes(10) });
      assert.ok(!isSuccess(sent.status), `another content type is refused, got ${sent.status}`);
      await expectKind('not-found', store.head(key), 'the key stays absent');
    },
  },
  {
    name: 'sign-upload-no-overwrite',
    async run({ store, send, capabilities }) {
      const key = `${freshPrefix()}/a`;
      const header = capabilities.createOnlyHeader;
      const other = header === 'if-none-match' ? 'x-goog-if-generation-match' : 'if-none-match';
      const first = patternBytes(10);
      const one = await store.signUpload(key, { size: 10, contentType: binary, ttlSeconds: 600, ifNoneMatch: true });
      assert.equal(one.headers[header], createOnlyValue(header), 'the create-only header is signed with its value');
      assert.equal(one.headers[other], undefined, 'the other create-only header is not');
      assert.ok(isSuccess((await send({ method: 'PUT', url: one.url, headers: one.headers, body: first })).status));
      const two = await store.signUpload(key, { size: 12, contentType: binary, ttlSeconds: 600, ifNoneMatch: true });
      const refused = await send({ method: 'PUT', url: two.url, headers: two.headers, body: patternBytes(12) });
      assert.equal(refused.status, 412, 'a second create-only upload to the key is refused with 412');
      assert.deepEqual(
        await readAll((await store.get(key)).body),
        first,
        'the refused upload leaves the object unchanged',
      );
    },
  },
  {
    name: 'create-only-header-stripped',
    requires: 'signedHeadersEnforced',
    async run({ store, send, capabilities }) {
      const fresh = `${freshPrefix()}/a`;
      const taken = `${freshPrefix()}/b`;
      const original = patternBytes(10);
      await store.put(taken, original, { size: 10, contentType: binary });
      for (const key of [fresh, taken]) {
        const signed = await store.signUpload(key, {
          size: 10,
          contentType: binary,
          ttlSeconds: 600,
          ifNoneMatch: true,
        });
        const headers = { ...signed.headers };
        delete headers[capabilities.createOnlyHeader];
        const sent = await send({ method: 'PUT', url: signed.url, headers, body: patternBytes(10) });
        assert.ok(
          !isSuccess(sent.status),
          `an upload without the signed create-only header is refused, got ${sent.status}`,
        );
      }
      await expectKind('not-found', store.head(fresh), 'the fresh key stays absent');
      assert.deepEqual(await readAll((await store.get(taken)).body), original, 'the existing object is unchanged');
    },
  },
  {
    name: 'sign-upload-expired',
    async run({ store, send, advance }) {
      const key = `${freshPrefix()}/a`;
      const signed = await store.signUpload(key, { size: 10, contentType: binary, ttlSeconds: 2 });
      await advance(3);
      const sent = await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: patternBytes(10) });
      assert.ok(!isSuccess(sent.status), `an expired signature is refused, got ${sent.status}`);
      await expectKind('not-found', store.head(key), 'the key stays absent');
    },
  },
  {
    name: 'sign-download-overrides',
    async run({ store, send }) {
      const key = `${freshPrefix()}/a`;
      const bytes = patternBytes(64);
      await store.put(key, bytes, { size: 64, contentType: binary });
      const hostile = 'caf\u00e9\r\nx-injected: yes\r\n.png';
      const signed = await store.signDownload(key, {
        ttlSeconds: 600,
        disposition: 'attachment',
        fileName: hostile,
        contentType: 'text/plain',
      });
      assert.ok(signed.expiresAt > 0);
      const got = await send({ method: 'GET', url: signed.url });
      assert.equal(got.status, 200);
      assert.deepEqual(got.body, bytes);
      assert.ok(
        got.headers['content-type']?.startsWith('text/plain'),
        'the signed content type overrides the stored one',
      );
      const disposition = got.headers['content-disposition'] ?? '';
      assert.ok(disposition.startsWith('attachment'), 'the signed disposition is used');
      assert.ok(disposition.includes("filename*=UTF-8''caf%C3%A9"), 'a non-ASCII name is carried encoded');
      assert.equal(got.headers['x-injected'], undefined, 'a line break in the name cannot add a header');
      for (const value of Object.values(got.headers)) assert.ok(!/[\r\n]/.test(value), 'no header holds a line break');
      const inline = await store.signDownload(key, { ttlSeconds: 600, disposition: 'inline' });
      const plain = await send({ method: 'GET', url: inline.url });
      assert.equal(plain.status, 200);
      assert.ok(plain.headers['content-disposition']?.startsWith('inline'));
      assert.ok(plain.headers['content-type']?.startsWith(binary), 'without an override the stored type is kept');
    },
  },
  {
    name: 'signed-urls-use-public-endpoint',
    async run({ store, publicOrigin }) {
      const key = `${freshPrefix()}/a`;
      const up = await store.signUpload(key, { size: 1, contentType: binary, ttlSeconds: 60 });
      const down = await store.signDownload(key, { ttlSeconds: 60, disposition: 'inline' });
      for (const url of [up.url, down.url]) {
        assert.ok(
          url.startsWith(`${publicOrigin}/`),
          `a signed URL starts with the public endpoint, got ${url.slice(0, 40)}`,
        );
      }
    },
  },
  {
    name: 'anonymous-denied',
    requires: 'anonymousDenied',
    async run({ store, send, unsignedUrl }) {
      const key = `${freshPrefix()}/a`;
      await store.put(key, patternBytes(5), { size: 5, contentType: binary });
      const got = await send({ method: 'GET', url: unsignedUrl(key) });
      assert.ok(got.status === 401 || got.status === 403, `an unsigned read is denied, got ${got.status}`);
    },
  },
  {
    name: 'cors-preflight',
    requires: 'cors',
    async run({ store, send, corsOrigin }) {
      const key = `${freshPrefix()}/a`;
      const signed = await store.signUpload(key, { size: 5, contentType: binary, ttlSeconds: 60, ifNoneMatch: true });
      const origin = corsOrigin ?? 'https://app.example.test';
      const answer = await send({
        method: 'OPTIONS',
        url: signed.url,
        headers: {
          origin,
          'access-control-request-method': 'PUT',
          'access-control-request-headers': Object.keys(signed.headers).join(','),
        },
      });
      assert.ok(isSuccess(answer.status), `the preflight is answered, got ${answer.status}`);
      const allowed = answer.headers['access-control-allow-origin'];
      assert.ok(allowed === origin || allowed === '*', 'the origin is allowed');
      assert.ok((answer.headers['access-control-allow-methods'] ?? '').toUpperCase().includes('PUT'), 'PUT is allowed');
    },
  },
  {
    name: 'stream-200mb-flat-memory',
    requires: 'flatMemory',
    async run({ store, collectGarbage }) {
      const key = `${freshPrefix()}/big`;
      const size = 1024 * 1024;
      const chunks = 200;
      // A pool of 16 different chunks is built once, before the baseline, and cycled: a store that keeps one chunk
      // or repeats the first cannot match the hash, and the test itself makes no garbage while memory is measured.
      const pool = Array.from({ length: 16 }, (_, i) => patternBytes(size).map((byte) => (byte + i) & 0xff));
      const chunkAt = (i: number): Uint8Array => pool[i % pool.length] as Uint8Array;
      const expected = createHash('sha256');
      for (let i = 0; i < chunks; i++) expected.update(chunkAt(i));
      const before = process.memoryUsage().rss;
      let peak = before;
      let samples = 0;
      const sample = () => {
        // Garbage that has not been collected yet is not memory the store keeps: collect now and then.
        if (++samples % 20 === 0) collectGarbage?.();
        peak = Math.max(peak, process.memoryUsage().rss);
      };
      // The OS keeps the process's peak RSS, so a transient 200 MB join inside the store shows up without any timer;
      // it counts only where it passes the peak reached earlier in the process. RSS is also read at every chunk and
      // when each call returns.
      const peakBefore = process.resourceUsage().maxRSS * 1024;
      const actual = createHash('sha256');
      let length = 0;
      const generated = (async function* () {
        for (let i = 0; i < chunks; i++) {
          sample();
          yield chunkAt(i);
        }
      })();
      await store.put(key, generated, { size: size * chunks, contentType: binary });
      sample();
      const got = await store.get(key);
      for await (const part of got.body) {
        actual.update(part);
        length += part.length;
        sample();
      }
      sample();
      await store.delete(key);
      assert.equal(length, size * chunks);
      assert.equal(actual.digest('hex'), expected.digest('hex'), 'the bytes read back are the bytes written');
      const grown = Math.max(peak - before, process.resourceUsage().maxRSS * 1024 - Math.max(peakBefore, before));
      assert.ok(grown < 50 * 1024 * 1024, `RSS grew by ${Math.round(grown / 1048576)} MB`);
    },
  },
  {
    name: 'multipart-roundtrip',
    async run({ store, send }) {
      const key = `${freshPrefix()}/m`;
      const first = patternBytes(MIN_PART_BYTES);
      const last = patternBytes(100);
      const { uploadId } = await store.createMultipart(key, { contentType: 'application/zip' });
      await expectKind('not-found', store.head(key), 'the object does not exist before the upload is completed');
      for (const [i, bytes] of [first, last].entries()) {
        const signed = await store.signPart(key, { uploadId, partNumber: i + 1, size: bytes.length, ttlSeconds: 600 });
        assert.equal(signed.method, 'PUT');
        assert.ok(signed.expiresAt > 0 && Number.isFinite(signed.expiresAt), 'expiresAt is a time in milliseconds');
        const sent = await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: bytes });
        assert.ok(isSuccess(sent.status), `part ${i + 1} is accepted, got ${sent.status}`);
      }
      assert.deepEqual(await store.listParts(key, uploadId), [
        { partNumber: 1, size: MIN_PART_BYTES },
        { partNumber: 2, size: 100 },
      ]);
      const done = await store.completeMultipart(key, uploadId);
      assert.equal(done.size, MIN_PART_BYTES + 100);
      const head = await store.head(key);
      assert.equal(head.size, MIN_PART_BYTES + 100);
      assert.equal(head.contentType, 'application/zip');
      const across = await readAll((await store.get(key, { range: { start: MIN_PART_BYTES - 4, end: MIN_PART_BYTES + 3 } })).body);
      assert.deepEqual(across, new Uint8Array([...first.subarray(MIN_PART_BYTES - 4), ...last.subarray(0, 4)]), 'a range across the part boundary');
      await store.delete(key);
    },
  },
  {
    name: 'multipart-part-size-and-number-signed',
    async run({ store, send }) {
      const key = `${freshPrefix()}/m`;
      const { uploadId } = await store.createMultipart(key, { contentType: binary });
      try {
        const signed = await store.signPart(key, { uploadId, partNumber: 1, size: 10, ttlSeconds: 600 });
        for (const length of [11, 9, 0]) {
          const sent = await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: patternBytes(length) });
          assert.ok(!isSuccess(sent.status), `a body of ${length} bytes for a signed part of 10 is refused, got ${sent.status}`);
        }
        const url = new URL(signed.url);
        assert.ok(url.searchParams.has('partNumber'), 'the part number is a query parameter of the signed URL');
        url.searchParams.set('partNumber', '2');
        const moved = await send({ method: 'PUT', url: url.toString(), headers: signed.headers, body: patternBytes(10) });
        assert.ok(!isSuccess(moved.status), `a signed URL moved to another part number is refused, got ${moved.status}`);
        assert.deepEqual(await store.listParts(key, uploadId), [], 'nothing was stored by the refused parts');
      } finally {
        await store.abortMultipart(key, uploadId);
      }
    },
  },
  {
    name: 'multipart-resume-and-resend',
    async run({ store, send }) {
      const key = `${freshPrefix()}/m`;
      const { uploadId } = await store.createMultipart(key, { contentType: binary });
      const put = async (partNumber: number, bytes: Uint8Array): Promise<void> => {
        const signed = await store.signPart(key, { uploadId, partNumber, size: bytes.length, ttlSeconds: 600 });
        const sent = await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: bytes });
        assert.ok(isSuccess(sent.status), `part ${partNumber} is accepted, got ${sent.status}`);
      };
      const second = patternBytes(7);
      await put(2, patternBytes(7));
      await put(1, patternBytes(MIN_PART_BYTES));
      assert.deepEqual((await store.listParts(key, uploadId)).map((p) => p.partNumber), [1, 2], 'the parts are listed in order, whatever order they came in');
      await put(2, second);
      assert.deepEqual(await store.listParts(key, uploadId), [{ partNumber: 1, size: MIN_PART_BYTES }, { partNumber: 2, size: 7 }], 'a part sent again (a retry, with the same bytes) is listed once');
      await store.completeMultipart(key, uploadId);
      assert.deepEqual(await readAll((await store.get(key, { range: { start: MIN_PART_BYTES, end: MIN_PART_BYTES + 6 } })).body), second, 'the object holds the part');
      await store.delete(key);
    },
  },
  {
    name: 'multipart-abort-and-unknown',
    async run({ store, send }) {
      const key = `${freshPrefix()}/m`;
      const { uploadId } = await store.createMultipart(key, { contentType: binary });
      const signed = await store.signPart(key, { uploadId, partNumber: 1, size: 5, ttlSeconds: 600 });
      assert.ok(isSuccess((await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: patternBytes(5) })).status));
      await store.abortMultipart(key, uploadId);
      await store.abortMultipart(key, uploadId);
      const stale = await store.signPart(key, { uploadId, partNumber: 2, size: 5, ttlSeconds: 600 });
      assert.ok(!isSuccess((await send({ method: 'PUT', url: stale.url, headers: stale.headers, body: patternBytes(5) })).status), 'a part sent to an aborted upload is refused by the store');
      await expectKind('not-found', store.listParts(key, uploadId), 'an aborted upload is unknown');
      await expectKind('not-found', store.completeMultipart(key, uploadId), 'an aborted upload cannot be completed');
      await expectKind('not-found', store.head(key), 'no object was made');
      await expectKind('invalid-key', store.createMultipart('../x', { contentType: binary }), 'a key is checked');
    },
  },
  {
    name: 'multipart-complete-refuses-bad-part-lists',
    async run({ store, send }) {
      const key = `${freshPrefix()}/m`;
      const { uploadId } = await store.createMultipart(key, { contentType: binary });
      try {
        await expectKind('invalid-parts', store.completeMultipart(key, uploadId), 'no part at all');
        const put = async (partNumber: number, bytes: Uint8Array): Promise<void> => {
          const signed = await store.signPart(key, { uploadId, partNumber, size: bytes.length, ttlSeconds: 600 });
          assert.ok(isSuccess((await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: bytes })).status));
        };
        await put(1, patternBytes(MIN_PART_BYTES));
        await put(3, patternBytes(10));
        await expectKind('invalid-parts', store.completeMultipart(key, uploadId), 'a gap: parts 1 and 3');
        await put(2, patternBytes(10));
        await expectKind('invalid-parts', store.completeMultipart(key, uploadId), 'a part but the last under the minimum size');
        await expectKind('not-found', store.head(key), 'a refused completion makes no object');
      } finally {
        await store.abortMultipart(key, uploadId);
      }
    },
  },
  {
    name: 'multipart-part-expired',
    async run({ store, send, advance }) {
      const key = `${freshPrefix()}/m`;
      const { uploadId } = await store.createMultipart(key, { contentType: binary });
      try {
        const signed = await store.signPart(key, { uploadId, partNumber: 1, size: 10, ttlSeconds: 2 });
        await advance(3);
        const sent = await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: patternBytes(10) });
        assert.ok(!isSuccess(sent.status), `an expired part signature is refused, got ${sent.status}`);
        assert.deepEqual(await store.listParts(key, uploadId), []);
      } finally {
        await store.abortMultipart(key, uploadId);
      }
    },
  },
  {
    name: 'multipart-list-spans-pages',
    async run({ store, send }) {
      const key = `${freshPrefix()}/m`;
      const { uploadId } = await store.createMultipart(key, { contentType: binary });
      try {
        const put = async (partNumber: number, bytes: Uint8Array): Promise<void> => {
          const signed = await store.signPart(key, { uploadId, partNumber, size: bytes.length, ttlSeconds: 600 });
          assert.ok(isSuccess((await send({ method: 'PUT', url: signed.url, headers: signed.headers, body: bytes })).status));
        };
        for (let n = 1; n <= 1001; n++) await put(n, patternBytes(1));
        await put(1000, patternBytes(1));
        const parts = await store.listParts(key, uploadId);
        assert.equal(parts.length, 1001, 'one entry for each of the 1001 parts, across the store\'s pages');
        assert.deepEqual(parts[999], { partNumber: 1000, size: 1 }, 'the part sent again is listed once');
      } finally {
        await store.abortMultipart(key, uploadId);
      }
    },
  },
];
