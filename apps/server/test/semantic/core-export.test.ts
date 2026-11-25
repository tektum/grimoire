import { describe, expect, it } from 'vitest';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';

// The server and the adapters take the key an embedding is stored under from the core, by the package's own name: it is one function, not a format each caller writes again.
describe('the core package exports the semantic modules', () => {
  it('lets the server import modelKey by the package name, and says name and version', () => {
    expect(modelKey({ name: 'multilingual-e5-base', version: 'int8@abcd1234' })).toBe('multilingual-e5-base-int8@abcd1234');
  });
});
