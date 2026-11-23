import { describe, expect, it } from 'vitest';
import { FileStorageError } from '../../src/ports/file-storage.js';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { FakeFileStorage } from '../../src/testing/fake-file-storage.js';
import {
  fileStorageConformance,
  type FileStorageCapabilities,
  type FileStorageHarness,
  type SignedResponse,
} from '../../src/testing/file-storage-conformance.js';

/**
 * Mutation check of the conformance suite (R13.26): each mutant is the fake with one rule broken, and the suite must
 * fail the cases that guard that rule. A suite that passes a mutant would pass a broken adapter too.
 */
const capabilities: FileStorageCapabilities = {
  cors: false,
  anonymousDenied: false,
  realExpiry: false,
  flatMemory: false,
  signedHeadersEnforced: true,
  createOnlyHeader: 'if-none-match',
};

/** Signs a size one byte too large, so the exact upload no longer matches what was signed. */
class WrongSizeSigner extends FakeFileStorage {
  override signUpload(...[key, o]: Parameters<FakeFileStorage['signUpload']>) {
    return super.signUpload(key, { ...o, size: o.size + 1 });
  }
}

/** Honours `ifNoneMatch` nowhere: every put overwrites. */
class IgnoresIfNoneMatch extends FakeFileStorage {
  override put(...[key, body, o]: Parameters<FakeFileStorage['put']>) {
    return super.put(key, body, { ...o, ifNoneMatch: false });
  }
}

/** Ignores the signed size: whatever body arrives is cut or padded to the signed length. */
class IgnoresSignedSize extends FakeFileStorage {
  override receiveSignedUpload(url: string, headers: Record<string, string>, body: Uint8Array) {
    const signed = this.signed.find((entry) => entry.kind === 'upload' && entry.url === url);
    const size = signed?.kind === 'upload' ? signed.size : body.length;
    const fitted = new Uint8Array(size);
    fitted.set(body.subarray(0, size));
    return super.receiveSignedUpload(url, headers, fitted);
  }
}

const refused = (error: unknown): SignedResponse => {
  if (!(error instanceof FileStorageError)) throw error;
  const status = error.kind === 'already-exists' ? 412 : error.kind === 'not-found' ? 404 : 403;
  return { status, headers: {}, body: new Uint8Array() };
};

function harness(
  make: (options: ConstructorParameters<typeof FakeFileStorage>[0]) => FakeFileStorage,
): FileStorageHarness {
  const clock = new FakeClock(1_000);
  const store = make({ clock });
  return {
    store,
    capabilities,
    publicOrigin: 'https://fake.invalid',
    unsignedUrl: (key) => `https://fake.invalid/${key}`,
    advance: async (seconds) => void clock.advance(seconds * 1000),
    send: async ({ method, url, headers = {}, body }) => {
      try {
        if (method === 'PUT') {
          await store.receiveSignedUpload(url, headers, body ?? new Uint8Array());
          return { status: 200, headers: {}, body: new Uint8Array() };
        }
        if (method === 'GET') return { status: 200, ...(await store.receiveSignedDownload(url)) };
        return { status: 405, headers: {}, body: new Uint8Array() };
      } catch (error) {
        return refused(error);
      }
    },
  };
}

/** The titles of the cases that fail on a store, among those its capabilities leave on. */
async function failing(
  make: (options: ConstructorParameters<typeof FakeFileStorage>[0]) => FakeFileStorage,
): Promise<string[]> {
  const failed: string[] = [];
  for (const c of fileStorageConformance) {
    if (c.requires !== undefined && !capabilities[c.requires]) continue;
    try {
      await c.run(harness(make));
    } catch {
      failed.push(c.name);
    }
  }
  return failed;
}

describe('the conformance suite fails a store with one rule broken', () => {
  it('passes the unbroken fake, so that every failure below comes from the mutation', async () => {
    expect(await failing((o) => new FakeFileStorage(o))).toEqual([]);
  });

  it('fails a store that signs the wrong size', async () => {
    expect(await failing((o) => new WrongSizeSigner(o))).toEqual([
      'sign-upload-exact',
      'sign-upload-wrong-size',
      'sign-upload-no-overwrite',
    ]);
  });

  it('fails a store that ignores ifNoneMatch', async () => {
    expect(await failing((o) => new IgnoresIfNoneMatch(o))).toEqual([
      'put-conditional-412',
      'sign-upload-no-overwrite',
    ]);
  });

  it('fails a store that ignores the signed size', async () => {
    expect(await failing((o) => new IgnoresSignedSize(o))).toEqual(['sign-upload-wrong-size']);
  });
});
