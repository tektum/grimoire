import { describe, expect, it } from 'vitest';
import { SESSION_CLOSE_CODES } from '../../src/extensions/limits.js';
import { FALLBACK_REFUSAL_CODE, GOING_AWAY, REFUSAL_CLOSE_CODES, SESSION_CLOSES } from '../../src/refusal.js';

describe('refusal close codes', () => {
  it('registers the handshake refusals', () => {
    expect(REFUSAL_CLOSE_CODES['stale-epoch']).toBe(4409);
    expect(REFUSAL_CLOSE_CODES['client-too-old']).toBe(4426);
  });

  it('the handshake codes are used by no other reason, so a client can tell them apart', () => {
    const others = [...Object.entries(REFUSAL_CLOSE_CODES).filter(([r]) => r !== 'stale-epoch' && r !== 'client-too-old').map(([, c]) => c), ...Object.values(SESSION_CLOSES)];
    expect(others).not.toContain(4409);
    expect(others).not.toContain(4426);
  });

  // R11.13: every close code the server uses, with the reasons that carry it. 1009 is the socket's own frame-size close (the `ws` maximum
  // payload), set by configuration and in no table; 4409 and 4426 are the handshake's.
  const SPEC: Record<number, string[]> = {
    1001: ['going-away'],
    4205: ['access-changed'],
    4400: ['bad-document-name'],
    4401: ['invalid-token', 'session-expired'],
    4403: ['forbidden'],
    4404: ['not-found'],
    4408: ['preauth-timeout'],
    4413: ['page-full'],
    4422: ['malformed-update'],
    4423: ['state-cap'],
    4429: ['rate-limited'],
    4500: ['state-corrupt', 'internal-error'],
    4501: ['seed-failed'],
    4503: ['server-full', 'documents-full', 'memory-guard', 'full-for-you', 'try-again'],
    4409: ['stale-epoch'],
    4426: ['client-too-old'],
  };

  it('every code of R11.13, and the two handshake codes, is registered with exactly its reasons, and no other code is used', () => {
    const registered: [string, number][] = [
      ['going-away', GOING_AWAY.code],
      ...Object.entries(REFUSAL_CLOSE_CODES),
      ...Object.entries(SESSION_CLOSES),
      ...Object.entries(SESSION_CLOSE_CODES),
    ];
    const byCode = new Map<number, string[]>();
    for (const [reason, code] of registered) byCode.set(code, [...(byCode.get(code) ?? []), reason]);
    expect(Object.fromEntries([...byCode].map(([code, reasons]) => [code, reasons.sort()]))).toEqual(
      Object.fromEntries(Object.entries(SPEC).map(([code, reasons]) => [code, [...reasons].sort()])),
    );
    expect(registered.map(([reason]) => reason).length).toBe(new Set(registered.map(([reason]) => reason)).size); // no reason twice
    expect(Object.keys(SPEC)).toHaveLength(16);
    expect(FALLBACK_REFUSAL_CODE).toBe(4500);
  });
});
