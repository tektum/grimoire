import { describe, expect, it } from 'vitest';
import type { SeedRefusal } from '@tektum/grimoire-core/pages/seeded-content';
import { seedRefusalToHttp } from '../../src/http/seed-errors.js';

const BUSY = 'The converter is busy with other pages. Try again in a moment.';
const seed = (reason: SeedRefusal['reason'], detail: string, message?: string) => ({ stage: 'seed' as const, reason, detail, ...(message ? { message } : {}) });
const back = (reason: SeedRefusal['reason']) => ({ stage: 'convert' as const, reason, detail: 'x' });

describe('seedRefusalToHttp', () => {
  it.each([
    ['the Markdown is 9 bytes; the limit is 8 bytes', 'too-large'],
    ['the Markdown has 9 lines; the limit is 8 lines', 'invalid-markdown'],
    ['line 3 has 51 quote or list markers; the limit is 50 per line', 'invalid-markdown'],
  ])('answers 422 invalid with the pool sentence: %s', (message, reason) => {
    expect(seedRefusalToHttp(seed(reason as SeedRefusal['reason'], 'limit', message))).toEqual({ code: 'invalid', message });
  });

  it('uses the limit sentence in detail when the pool sends no message', () => {
    expect(seedRefusalToHttp(seed('too-large', 'the Markdown is 9 bytes; the limit is 8 bytes'))).toEqual({
      code: 'invalid', message: 'the Markdown is 9 bytes; the limit is 8 bytes',
    });
  });

  it('answers 422 too complex, without Retry-After, when the conversion ran out of time', () => {
    expect(seedRefusalToHttp(seed('timeout', 'x'))).toEqual({ code: 'invalid', message: 'the Markdown is too complex to convert in the time allowed' });
  });

  it('answers 503 with Retry-After when no worker was free in time', () => {
    expect(seedRefusalToHttp(seed('queue-timeout', 'x'))).toEqual({ code: 'unavailable', message: BUSY, headers: { 'retry-after': '5' } });
    expect(seedRefusalToHttp(back('queue-timeout'))).toEqual({ code: 'unavailable', message: BUSY, headers: { 'retry-after': '5' } });
  });

  it('answers 429 rate_limited with Retry-After 2 for a second seed by one user', () => {
    expect(seedRefusalToHttp(seed('internal', 'one-at-a-time', 'Another one is running.'))).toEqual({
      code: 'rate_limited', message: 'Another conversion is still running. Try again in a moment.', headers: { 'retry-after': '2' },
    });
  });

  it.each([
    ['internal', 'queue-full'],
    ['internal', 'closed'],
    ['out-of-memory', 'x'],
    ['internal', 'x'],
    ['internal', 'no-key'],
  ])('answers 503 unavailable with Retry-After 5 for %s / %s', (reason, detail) => {
    expect(seedRefusalToHttp(seed(reason as SeedRefusal['reason'], detail))).toEqual({ code: 'unavailable', message: BUSY, headers: { 'retry-after': '5' } });
  });

  it.each(['content-lost', 'too-large'])('answers 422 invalid when %s follows a good seed', (reason) => {
    expect(seedRefusalToHttp(back(reason as SeedRefusal['reason'])).code).toBe('invalid');
  });

  it('answers 503 when the converter itself fails after a good seed', () => {
    expect(seedRefusalToHttp(back('internal'))).toMatchObject({ code: 'unavailable', headers: { 'retry-after': '5' } });
  });

  it('never repeats the detail of a refusal in the answer', () => {
    expect(JSON.stringify(seedRefusalToHttp(seed('internal', 'secret-detail')))).not.toContain('secret-detail');
  });

  it('uses fixed sentences when the pool sends none', () => {
    expect(seedRefusalToHttp(seed('invalid-markdown', 'x'))).toEqual({ code: 'invalid', message: 'The Markdown is not valid.' });
    expect(seedRefusalToHttp(seed('internal', 'one-at-a-time'))).toMatchObject({ code: 'rate_limited', message: 'Another conversion is still running. Try again in a moment.' });
    expect(seedRefusalToHttp(back('content-lost'))).toEqual({ code: 'invalid', message: 'The Markdown cannot be converted.' });
  });

  it('answers 422 too complex when the conversion back runs out of time', () => {
    expect(seedRefusalToHttp(back('timeout'))).toEqual({ code: 'invalid', message: 'the Markdown is too complex to convert in the time allowed' });
  });
});
