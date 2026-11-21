import { describe, expect, it } from 'vitest';
import { descopeBaseUrl } from '../src/index.js';

describe('region base URL', () => {
  it('a 28-character project id gives the global base', () => {
    expect(descopeBaseUrl('P3MKkY4NTeugh4LndRLzgCZJtoPS')).toBe('https://api.descope.com');
  });
  it('a regional project id gives the regional base', () => {
    expect(descopeBaseUrl(`Peu1${'x'.repeat(27)}`)).toBe('https://api.eu1.descope.com');
  });
  it('an explicit baseUrl wins and loses its trailing slash', () => {
    expect(descopeBaseUrl('P3MKkY4NTeugh4LndRLzgCZJtoPS', 'https://auth.example.com/')).toBe('https://auth.example.com');
    expect(descopeBaseUrl(`Peu1${'x'.repeat(27)}`, 'http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
  });
  it.each([
    ['credentials: user and password', 'https://user:pw@auth.example.com'],
    ['credentials: user only', 'https://user@auth.example.com'],
    ['credentials: password only', 'https://:pw@auth.example.com'],
    ['credentials on a loopback http address', 'http://user:pw@127.0.0.1:9999'],
    ['a query string', 'https://auth.example.com?x=1'],
    ['a query string after a path', 'https://auth.example.com/base?x=1'],
    ['a fragment', 'https://auth.example.com#frag'],
    ['a fragment on a loopback http address', 'http://127.0.0.1:9999/#frag'],
    ['plain http to a named host', 'http://auth.example.com'],
    ['plain http to a host that only starts like loopback', 'http://localhost.evil.com'],
    ['plain http to a host that only starts like an IPv4 loopback', 'http://127.0.0.1.evil.com'],
    ['plain http to another private address', 'http://10.0.0.1'],
    ['an ftp scheme', 'ftp://127.0.0.1'],
    ['a websocket scheme', 'wss://auth.example.com'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['text that is not a URL', 'nonsense'],
  ])('refuses a baseUrl with %s', (_name, baseUrl) => {
    expect(() => descopeBaseUrl('P3MKkY4NTeugh4LndRLzgCZJtoPS', baseUrl)).toThrow();
  });
  it.each([
    ['https with a port', 'https://auth.example.com:8443', 'https://auth.example.com:8443'],
    ['https with a path, trailing slashes removed', 'https://auth.example.com/base//', 'https://auth.example.com/base'],
    ['https with an upper-case scheme and host', 'HTTPS://Auth.Example.COM', 'https://auth.example.com'],
    ['http to localhost', 'http://localhost:3000', 'http://localhost:3000'],
    ['http to 127.0.0.1', 'http://127.0.0.1', 'http://127.0.0.1'],
    ['http to IPv6 loopback', 'http://[::1]:8080/', 'http://[::1]:8080'],
    ['https to loopback', 'https://127.0.0.1:8443', 'https://127.0.0.1:8443'],
  ])('accepts a baseUrl of %s', (_name, baseUrl, expected) => {
    expect(descopeBaseUrl('P3MKkY4NTeugh4LndRLzgCZJtoPS', baseUrl)).toBe(expected);
  });
  it('an absent or empty baseUrl falls back to the region of the project id', () => {
    expect(descopeBaseUrl(`Peu1${'x'.repeat(27)}`, undefined)).toBe('https://api.eu1.descope.com');
    expect(descopeBaseUrl(`Peu1${'x'.repeat(27)}`, '')).toBe('https://api.eu1.descope.com');
  });
});
