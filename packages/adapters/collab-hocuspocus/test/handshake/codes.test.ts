import { describe, expect, it } from 'vitest';
import { REFUSAL_CLOSE_CODES, SESSION_CLOSES } from '../../src/refusal.js';

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
});
