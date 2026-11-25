import { describe, expect, it } from 'vitest';
import { importFailedKey, importFailedPrefix, importZipKey } from '../../src/import/keys.js';

describe('the keys of an import', () => {
  it('are under the tenant of the import: the zip and each failed original', () => {
    expect(importZipKey('acme', 'imp-1')).toBe('tenants/acme/imports/imp-1/source.zip');
    expect(importFailedKey('acme', 'imp-1', '42')).toBe('tenants/acme/imports/imp-1/failed/42.md');
    expect(importFailedKey('acme', 'imp-1', '42').startsWith(importFailedPrefix('acme', 'imp-1'))).toBe(true);
  });

  it.each([['a/b'], [''], ['..'], ['a b'], ['x'.repeat(129)]])('refuse a tenant id that could change the path: %j', (tenant) => {
    expect(() => importZipKey(tenant, 'imp-1')).toThrow('tenant id');
  });

  it.each([['../x'], ['a/b'], [''], ['a.b']])('refuse an import id or an item id that could change the path: %j', (id) => {
    expect(() => importZipKey('acme', id)).toThrow('import id');
    expect(() => importFailedKey('acme', 'imp-1', id)).toThrow('item id');
  });
});
