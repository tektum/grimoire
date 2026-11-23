import { describe, expect, it } from 'vitest';
import { REFUSAL_CLOSE_CODES, SESSION_CLOSES } from '../../src/refusal.js';

describe('refusal close codes', () => {
  it('registers the handshake refusals', () => {
    expect(REFUSAL_CLOSE_CODES['stale-epoch']).toBe(4409);
    expect(REFUSAL_CLOSE_CODES['client-too-old']).toBe(4426);
  });

  it('no two reasons that must be told apart share a code', () => {
    const shared = new Set([4503, 4500]); // retryable capacity reasons and internal errors share by design
    const codes = [...Object.values(REFUSAL_CLOSE_CODES), ...Object.values(SESSION_CLOSES)].filter((c) => !shared.has(c));
    const reasons = [...Object.keys(REFUSAL_CLOSE_CODES), ...Object.keys(SESSION_CLOSES)];
    expect(reasons.length).toBeGreaterThanOrEqual(codes.length);
    expect(new Set(codes).size).toBe(codes.length - 1); // 4401 is shared by invalid-token and session-expired, both "sign in again"
  });
});
