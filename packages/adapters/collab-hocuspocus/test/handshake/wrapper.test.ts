import { describe, expect, it } from 'vitest';
import { MAX_HANDSHAKE_LENGTH, MAX_TOKEN_LENGTH, compareVersions, parseVersion, readHandshake } from '../../src/handshake.js';
import { createAuthExtension } from '../../src/extensions/auth.js';
import { PAGE, makeDeps } from '../host/support.js';

const wrap = (o: unknown): string => `g1.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
const OPTIONS = { requireHandshake: false, minClientVersion: '1.2.0' };

const BAD: [string, string][] = [
  ['a bare token of 8,193 characters', 'x'.repeat(MAX_TOKEN_LENGTH + 1)],
  ['a wrapped token of 8,193 characters', wrap({ t: 'x'.repeat(MAX_TOKEN_LENGTH + 1) })],
  ['a wrapper over its cap', `g1.${'A'.repeat(MAX_HANDSHAKE_LENGTH)}`],
  ['bad base64url', 'g1.!!!'],
  ['base64url of non-JSON', `g1.${Buffer.from('not json').toString('base64url')}`],
  ['an array', wrap([1])],
  ['no fields', wrap({})],
  ['an empty token', wrap({ t: '' })],
  ['a non-string token', wrap({ t: 5 })],
  ['a two-part version', wrap({ t: 'x', v: '1.2' })],
  ['a numeric version', wrap({ t: 'x', v: 1 })],
  ['a negative epoch', wrap({ t: 'x', e: -1 })],
  ['a fractional epoch', wrap({ t: 'x', e: 1.5 })],
  ['an epoch beyond 2147483647', wrap({ t: 'x', e: 2147483648 })],
  ['a string epoch', wrap({ t: 'x', e: '1' })],
  ['invalid UTF-8', `g1.${Buffer.from([0xff, 0xfe]).toString('base64url')}`],
];

describe('handshake wrapper', () => {
  it.each(BAD)('%s is refused invalid-token and the verifier is never called', async (_name, token) => {
    expect(() => readHandshake(token, OPTIONS)).toThrow(expect.objectContaining({ reason: 'invalid-token' }));
    const t = makeDeps('member');
    const ext = createAuthExtension({ deps: t.deps, log: t.log, peers: t.peers, guard: t.guard });
    const data = { token, documentName: PAGE, context: { peerId: 'p1', address: 'a' }, connectionConfig: { readOnly: false } };
    await expect(ext.onAuthenticate?.(data as never)).rejects.toMatchObject({ reason: 'invalid-token' });
    expect(t.verifier.calls).toBe(0);
  });

  it('a session token of exactly 8,192 characters passes bare and wrapped, with room for version and epoch', () => {
    const t = 'x'.repeat(MAX_TOKEN_LENGTH);
    expect(readHandshake(t, OPTIONS).token).toBe(t);
    const wrapped = wrap({ t, v: '99.99.99', e: 2147483647 });
    expect(wrapped.length).toBeLessThanOrEqual(MAX_HANDSHAKE_LENGTH);
    expect(readHandshake(wrapped, OPTIONS).token).toBe(t);
  });

  it('a configured floor with leading zeros still gates, and an unreadable floor fails closed', () => {
    const old = wrap({ t: 'x', v: '1.1.9' });
    expect(() => readHandshake(old, { ...OPTIONS, minClientVersion: '1.02.0' })).toThrow(expect.objectContaining({ reason: 'client-too-old' }));
    expect(() => readHandshake(old, { ...OPTIONS, minClientVersion: '1.20.03' })).toThrow(expect.objectContaining({ reason: 'client-too-old' }));
    expect(() => readHandshake(old, { ...OPTIONS, minClientVersion: 'latest' })).toThrow('minClientVersion');
  });

  it('a non-string token is invalid', () => {
    expect(() => readHandshake(undefined, OPTIONS)).toThrow(expect.objectContaining({ reason: 'invalid-token' }));
  });

  it('a bare token is accepted without the requirement and refused client-too-old with it', async () => {
    expect(readHandshake('bare', OPTIONS)).toEqual({ token: 'bare', wrapped: false });
    expect(() => readHandshake('bare', { ...OPTIONS, requireHandshake: true })).toThrow(expect.objectContaining({ reason: 'client-too-old' }));
    const t = makeDeps('member');
    t.deps = { ...t.deps, config: { ...t.deps.config, requireHandshake: true } };
    const ext = createAuthExtension({ deps: t.deps, log: t.log, peers: t.peers, guard: t.guard });
    const data = { token: 'bare', documentName: PAGE, context: { peerId: 'p1', address: 'a' }, connectionConfig: { readOnly: false } };
    await expect(ext.onAuthenticate?.(data as never)).rejects.toMatchObject({ reason: 'client-too-old' });
    expect(t.verifier.calls).toBe(0);
  });

  it('a wrapper is decoded to its token, version and epoch', () => {
    expect(readHandshake(wrap({ t: 'abc', v: '2.0.1', e: 7 }), OPTIONS)).toEqual({ token: 'abc', wrapped: true, version: [2, 0, 1], epoch: 7 });
    expect(readHandshake(wrap({ t: 'abc', e: 0 }), OPTIONS)).toEqual({ token: 'abc', wrapped: true, epoch: 0 });
    expect(readHandshake(wrap({ t: 'abc' }), OPTIONS)).toEqual({ token: 'abc', wrapped: true });
  });

  it('a version below the minimum is refused client-too-old; the minimum and above are accepted', () => {
    expect(() => readHandshake(wrap({ t: 'x', v: '1.1.9' }), OPTIONS)).toThrow(expect.objectContaining({ reason: 'client-too-old' }));
    for (const v of ['1.2.0', '2.0.0', '1.10.0']) expect(readHandshake(wrap({ t: 'x', v }), OPTIONS).token).toBe('x');
  });

  it('versions compare numerically, not as text', () => {
    expect(parseVersion('1.10.0')).toEqual([1, 10, 0]);
    expect(parseVersion('01.2.3')).toBeUndefined();
    expect(compareVersions([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});
