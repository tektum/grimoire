import { describe, expect, it } from 'vitest';
import { modelKey } from '../../src/semantic/model-key.js';

describe('modelKey', () => {
  it('is the name and the version of the model, in the form the contracts give', () => {
    expect(modelKey({ name: 'multilingual-e5-base', version: 'int8@3fa9c0d1' })).toBe('multilingual-e5-base-int8@3fa9c0d1');
  });

  it('differs for another version of the same model and for another model of the same version, so that new weights are not read as the old ones', () => {
    const base = modelKey({ name: 'multilingual-e5-base', version: 'int8@aaaaaaaa' });
    expect(modelKey({ name: 'multilingual-e5-base', version: 'int8@bbbbbbbb' })).not.toBe(base);
    expect(modelKey({ name: 'multilingual-e5-small', version: 'int8@aaaaaaaa' })).not.toBe(base);
  });
});
