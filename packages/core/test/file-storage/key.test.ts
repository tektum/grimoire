import { describe, expect, it } from 'vitest';
import { FileStorageError, assertValidKey, isValidKey } from '../../src/ports/file-storage.js';

const invalid: [string, string][] = [
  ['empty', ''],
  ['empty segment', 'a//b'],
  ['dot segment', 'a/./b'],
  ['parent segment', '../x'],
  ['trailing parent segment', 'a/..'],
  ['leading slash', '/x'],
  ['trailing slash', 'x/'],
  ['backslash', 'a\\b'],
  ['NUL', 'a\u0000b'],
  ['newline', 'a\nb'],
  ['DEL', 'a\u007fb'],
  ['C1 control (next line)', 'a\u0085b'],
  ['lone high surrogate', 'a\ud800b'],
  ['lone low surrogate', 'a\udc00b'],
  ['513 bytes', 'a'.repeat(513)],
  ['513 bytes from multi-byte characters', 'é'.repeat(257)],
];

describe('isValidKey', () => {
  it.each(invalid)('refuses %s', (_name, key) => {
    expect(isValidKey(key)).toBe(false);
    expect(() => assertValidKey(key)).toThrow(FileStorageError);
    try {
      assertValidKey(key);
    } catch (error) {
      expect((error as FileStorageError).kind).toBe('invalid-key');
    }
  });

  it.each([
    ['an attachment key', `attachments/${'0123abcd-0123-4abc-8abc-0123456789ab'}`],
    ['a single segment', 'x'],
    ['a dot inside a name', 'a/b.c/..d'],
    ['512 bytes', 'a'.repeat(512)],
    ['512 bytes from multi-byte characters', 'é'.repeat(256)],
    ['a valid surrogate pair', 'a/\u{1f600}'],
    ['a percent sign, which is kept literally', 'a/%2e/b'],
  ])('accepts %s', (_name, key) => {
    expect(isValidKey(key)).toBe(true);
    expect(() => assertValidKey(key)).not.toThrow();
  });

  it('carries the kind and name on the error', () => {
    const error = new FileStorageError('not-found', 'gone');
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('not-found');
    expect(error.name).toBe('FileStorageError');
    expect(error.message).toBe('gone');
  });
});
