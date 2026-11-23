import { describe, expect, it, vi } from 'vitest';
import { loadWebConfig } from '../../src/config';
import { createClientStorage } from '../../src/storage';

const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('loadWebConfig', () => {
  it('reads ./config.json without credentials, trims the trailing slash and defaults the hidden time', async () => {
    const f = reply({ apiUrl: 'https://api.example/' });
    expect(await loadWebConfig(f as never)).toEqual({ apiUrl: 'https://api.example', hiddenDisconnectMs: 600000 });
    expect(f).toHaveBeenCalledWith('./config.json', expect.objectContaining({ credentials: 'omit' }));
  });
  it('takes a given hiddenDisconnectMs', async () => {
    expect((await loadWebConfig(reply({ apiUrl: 'x', hiddenDisconnectMs: 5 }) as never)).hiddenDisconnectMs).toBe(5);
  });
  it.each([[{}], [{ apiUrl: '' }], [{ apiUrl: 'x', hiddenDisconnectMs: 'a' }], [{ apiUrl: 'x', hiddenDisconnectMs: -1 }], [null]])('rejects %j', async (body) => {
    await expect(loadWebConfig(reply(body) as never)).rejects.toThrow('config.json');
  });
  it('rejects an HTTP error', async () => {
    await expect(loadWebConfig(reply({}, 404) as never)).rejects.toThrow('HTTP 404');
  });
});

describe('ClientStorage', () => {
  it('prefixes keys and survives a blocked backend', () => {
    const m = new Map<string, string>();
    const s = createClientStorage({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) });
    s.set('last-collection', 'c1');
    expect([...m.keys()]).toEqual(['grimoire.last-collection']);
    expect(s.get('last-collection')).toBe('c1');
    s.remove('last-collection');
    expect(s.get('last-collection')).toBeNull();
    const boom = () => { throw new Error('blocked'); };
    const b = createClientStorage({ getItem: boom, setItem: boom, removeItem: boom });
    b.set('a', 'b'); b.remove('a');
    expect(b.get('a')).toBeNull();
    expect(createClientStorage(null).get('a')).toBeNull();
  });
});
