import { expect, it } from 'vitest';
import type { VerifyResult } from '../../src/ports/auth-verifier.js';

type Ok = Extract<VerifyResult, { kind: 'ok' }>;

it('VerifyResult ok keeps the existing keys and adds an optional profile', () => {
  const result: Ok = { kind: 'ok', userId: 'alice', expiresAt: 1000 };
  expect(result).toEqual({ kind: 'ok', userId: 'alice', expiresAt: 1000 });
});
