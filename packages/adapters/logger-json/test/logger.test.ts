import { describe, expect, it } from 'vitest';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { createJsonLogger } from '../src/index.js';
import { dsn } from './dsn.js';

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const clock = new FakeClock(Date.UTC(2026, 10, 20));
  const log = createJsonLogger({ destination: { write: (l) => lines.push(l.trimEnd()) }, clock, ...(level ? { level } : {}) });
  return { lines, log, clock };
}

describe('logger-json', () => {
  it('writes one parseable JSON line with ts, level and event', () => {
    const { lines, log } = capture();
    log.info('connect', { page: 'p1', bytes: 5 });
    log.warn('refused', { reason: 'rate' });
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).not.toContain('\n');
      const o = JSON.parse(l) as Record<string, unknown>;
      expect(typeof o['ts']).toBe('string');
      expect(['info', 'warn']).toContain(o['level']);
      expect(typeof o['event']).toBe('string');
    }
    expect(JSON.parse(lines[0] ?? '')).toEqual({ page: 'p1', bytes: 5, ts: '2026-11-20T00:00:00.000Z', level: 'info', event: 'connect' });
  });

  it('never writes a token field or a URL query string', () => {
    const { lines, log } = capture();
    log.info('connect', {
      token: 'abc.secret.jwt',
      nested: { Password: 'pw-123', authToken: 't2', list: ['ok'] },
      url: 'wss://host/collab?token=abc.secret.jwt&x=1',
      dsn: dsn('u:dbpass-99', 'h/db'),
      note: 'GET /p?token=zzz-leak failed',
    });
    const out = lines.join('\n');
    for (const secret of ['abc.secret.jwt', 'pw-123', 't2', 'dbpass-99', 'zzz-leak', 'x=1']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('wss://host/collab');
    expect(out).toContain('"ok"');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ts: expect.any(String), level: 'info', event: 'connect' });
  });

  it('filters below the level and merges child fields', () => {
    const { lines, log } = capture('warn');
    log.info('dropped');
    log.child({ role: 'api' }).error('boom', { err: new Error('failed at /x?token=q1') });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"role":"api"');
    expect(lines[0]).not.toContain('q1');
  });

  it('does not let fields override ts, level or event, and survives cycles', () => {
    const { lines, log } = capture();
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    log.info('real', { level: 'fake', event: 'fake', ts: 'x', cyc });
    const o = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(o).toMatchObject({ level: 'info', event: 'real' });
    expect(o['ts']).not.toBe('x');
  });
});
