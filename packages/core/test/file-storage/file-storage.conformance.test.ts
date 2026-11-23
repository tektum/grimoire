import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { FakeFileStorage } from '../../src/testing/fake-file-storage.js';
import {
  fileStorageConformance,
  type FileStorageCapabilities,
  type FileStorageHarness,
} from '../../src/testing/file-storage-conformance.js';

/** The pinned case titles (contracts section 2) this suite has so far; the test fails when one goes missing. */
const titles =
  'put-head-get range-first-512 range-middle range-past-end get-absent delete-absent list-paging key-validation put-conditional-412'.split(
    ' ',
  );

const capabilities: FileStorageCapabilities = {
  cors: false,
  anonymousDenied: false,
  realExpiry: false,
  flatMemory: false,
};

const harness = (): FileStorageHarness => ({ store: new FakeFileStorage({ clock: new FakeClock(1_000) }) });

describe('FakeFileStorage conformance (the cases an adapter must also pass)', () => {
  it('has every pinned title, once', () => {
    const names = fileStorageConformance.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(titles));
    expect(new Set(names).size).toBe(names.length);
  });

  for (const c of fileStorageConformance) {
    const missing = c.requires !== undefined && !capabilities[c.requires];
    const title = missing ? `${c.name} (skipped: capability ${c.requires} is false)` : c.name;
    it.skipIf(missing)(title, () => c.run(harness()));
  }
});
