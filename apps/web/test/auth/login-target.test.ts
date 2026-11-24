import { describe, expect, it } from 'vitest';
import { appTarget } from '../../src/screens/login/target';

const ORIGIN = 'https://app.example.test';

describe('appTarget', () => {
  it('keeps a path of this app with its query and fragment, as an address on this origin', () => {
    expect(appTarget('/p/some-page-ab12cd?x=1#top', ORIGIN)).toBe(`${ORIGIN}/p/some-page-ab12cd?x=1#top`);
    expect(appTarget('/', ORIGIN)).toBe(`${ORIGIN}/`);
    expect(appTarget('/search?q=a%20b', ORIGIN)).toBe(`${ORIGIN}/search?q=a%20b`);
  });

  it.each([
    ['//evil.example'],
    ['///evil.example/x'],
    ['/\\evil.example'], // a browser reads the backslash as a slash: another host
    ['\\\\evil.example'],
    ['https://evil.example/'],
    ['http://app.example.test.evil.example/'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['/\n/evil.example'],
    ['https://app.example.test@evil.example/'],
    ['http://[::1'],
  ])('sends %j to the start page of this origin', (bad) => {
    expect(appTarget(bad, ORIGIN)).toBe(`${ORIGIN}/`);
  });

  it('reads what a browser reads, and what it makes of a tab or a scheme without slashes stays a path of this origin', () => {
    // The parser drops a tab inside the address and reads `https:x` as a relative reference: both end up on this origin, never on another.
    expect(appTarget('/\tevil.example', ORIGIN)).toBe(`${ORIGIN}/evil.example`);
    expect(appTarget('https:evil.example', ORIGIN)).toBe(`${ORIGIN}/evil.example`);
  });

  it('treats an address on this very origin, written out in full, as a path of the app', () => {
    expect(appTarget('https://app.example.test/p/x', ORIGIN)).toBe(`${ORIGIN}/p/x`);
  });

  it('never returns an address on another origin, whatever it is given', () => {
    for (const input of ['//a.test', '/\\a.test', 'https://a.test', '/..//a.test', '/%2F%2Fa.test', '/.//a.test']) expect(new URL(appTarget(input, ORIGIN)).origin).toBe(ORIGIN);
  });
});
