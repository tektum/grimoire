import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  FileStorageError,
  type ByteStream,
  type FileStorage,
  type FileStorageErrorKind,
} from '../ports/file-storage.js';

/**
 * What a store can and cannot do in the test set-up. A case that needs a capability the store lacks is reported as
 * skipped with the capability's name, never left out.
 */
export interface FileStorageCapabilities {
  readonly cors: boolean;
  readonly anonymousDenied: boolean;
  readonly realExpiry: boolean;
  readonly flatMemory: boolean;
}

/** What a case needs besides the store. */
export interface FileStorageHarness {
  readonly store: FileStorage;
}

export interface FileStorageCase {
  readonly name: string;
  /** The capability that must be true for the case to run. */
  readonly requires?: keyof FileStorageCapabilities;
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
      await store.put(`${prefix}/${'a'.repeat(512 - prefix.length - 1)}`, patternBytes(1), {
        size: 1,
        contentType: binary,
      });
      // A percent-encoded dot segment is either refused (invalid-key) or kept as a literal name; whichever it does,
      // it must never reach the plain key, on a write, a read or a delete.
      const plain = `${prefix}/x`;
      const seeded = patternBytes(7);
      await store.put(plain, seeded, { size: 7, contentType: binary });
      for (const dots of ['%2e', '%2e%2e', '%2E']) {
        const escaped = `${prefix}/${dots}/x`;
        const refused = async (action: Promise<unknown>, what: string): Promise<boolean> => {
          try {
            await action;
            return false;
          } catch (error) {
            assert.ok(error instanceof FileStorageError, `${what}: ${String(error)}`);
            assert.ok(error.kind === 'invalid-key' || error.kind === 'not-found', `${what}: got ${error.kind}`);
            return true;
          }
        };
        await refused(store.put(escaped, patternBytes(9), { size: 9, contentType: binary }), `put ${dots}`);
        await refused(store.head(escaped), `head ${dots}`);
        const read = await store.get(escaped).then(
          async (got) => readAll(got.body),
          (error: unknown) => {
            assert.ok(
              error instanceof FileStorageError && ['invalid-key', 'not-found'].includes(error.kind),
              `get ${dots}`,
            );
            return null;
          },
        );
        assert.notDeepEqual(read, seeded, `get ${dots} must not read the plain key`);
        await store.delete(escaped).catch((error: unknown) => {
          assert.ok(error instanceof FileStorageError && error.kind === 'invalid-key', `delete ${dots}`);
        });
        assert.deepEqual(await readAll((await store.get(plain)).body), seeded, `${dots} must not touch the plain key`);
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
];
