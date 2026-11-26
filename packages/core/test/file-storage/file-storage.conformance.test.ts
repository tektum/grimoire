import { describe, expect, it } from 'vitest';
import { FileStorageError } from '../../src/ports/file-storage.js';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { FakeFileStorage } from '../../src/testing/fake-file-storage.js';
import {
  fileStorageConformance,
  type CreateOnlyHeader,
  type FileStorageCapabilities,
  type FileStorageHarness,
  type SignedResponse,
} from '../../src/testing/file-storage-conformance.js';

/** The pinned case titles (contracts section 2, plus the create-only case); the test fails when one goes missing. */
const titles =
  `put-head-get range-first-512 range-middle range-past-end get-absent delete-absent list-paging key-validation
  put-conditional-412 sign-upload-exact sign-upload-wrong-size sign-upload-wrong-type sign-upload-no-overwrite
  create-only-header-stripped sign-upload-expired sign-download-overrides signed-urls-use-public-endpoint
  anonymous-denied cors-preflight stream-200mb-flat-memory multipart-roundtrip
  multipart-part-size-and-number-signed multipart-resume-and-resend multipart-abort-and-unknown
  multipart-complete-refuses-bad-part-lists multipart-part-expired`.split(/\s+/);

const capabilitiesFor = (createOnlyHeader: CreateOnlyHeader): FileStorageCapabilities => ({
  cors: false,
  anonymousDenied: false,
  realExpiry: false,
  flatMemory: false,
  signedHeadersEnforced: true,
  createOnlyHeader,
});

const refused = (error: unknown): SignedResponse => {
  if (!(error instanceof FileStorageError)) throw error;
  const status = error.kind === 'already-exists' ? 412 : error.kind === 'not-found' ? 404 : 403;
  return { status, headers: {}, body: new Uint8Array() };
};

/** The fake seen as an HTTP endpoint: what a browser sends to a signed URL is what the fake receives. */
function harness(capabilities: FileStorageCapabilities): FileStorageHarness {
  const clock = new FakeClock(1_000);
  const store = new FakeFileStorage({ clock, createOnlyHeader: capabilities.createOnlyHeader });
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

describe.each(['if-none-match', 'x-goog-if-generation-match'] as const)(
  'FakeFileStorage conformance, create-only header %s (the cases an adapter must also pass)',
  (header) => {
    const capabilities = capabilitiesFor(header);

    it('has every pinned title, once, and no other', () => {
      const names = fileStorageConformance.map((c) => c.name);
      expect([...names].sort()).toEqual([...titles].sort());
    });

    it('reports the cases a false capability turns off, by the capability name, never by dropping them', () => {
      const off = fileStorageConformance.filter((c) => c.requires !== undefined && !capabilities[c.requires]);
      expect(off.map((c) => [c.name, c.requires])).toEqual([
        ['anonymous-denied', 'anonymousDenied'],
        ['cors-preflight', 'cors'],
        ['stream-200mb-flat-memory', 'flatMemory'],
      ]);
    });

    for (const c of fileStorageConformance) {
      const missing = c.requires !== undefined && !capabilities[c.requires];
      const title = missing ? `${c.name} (skipped: capability ${c.requires} is false)` : c.name;
      it.skipIf(missing)(title, () => c.run(harness(capabilities)));
    }
  },
);
