import { pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scramVerifier, setupDatabase } from '../src/index.js';
import type { KyselyDatabase } from '../src/index.js';

const PASSWORDS = { app: 'app-password-0123456789', migrator: 'migrator-password-0123456789', ops: 'ops-password-0123456789' };

/** A database that records every statement and parameter it is given, and answers the few questions `setupDatabase` asks. */
function recorder() {
  const seen: { text: string; params: readonly unknown[] }[] = [];
  const query = (text: string, params: readonly unknown[] = []) => {
    seen.push({ text, params });
    if (text.startsWith('select quote_')) return Promise.resolve([{ q: `'${String(params[0])}'` }]);
    if (text.includes('from pg_roles where rolname = $1')) return Promise.resolve([]);
    if (text.includes('current_database')) return Promise.resolve([{ name: 'grimoire' }]);
    if (text.includes('rolsuper')) return Promise.resolve([{ super: true }]);
    return Promise.resolve([]);
  };
  const db = { query, transaction: <T>(fn: (tx: { query: typeof query }) => Promise<T>) => fn({ query }) } as unknown as KyselyDatabase;
  return { db, seen };
}

describe('the SCRAM verifier', () => {
  it('has the shape PostgreSQL stores, and its keys follow RFC 5802 for the password and salt', () => {
    const salt = Buffer.from('0123456789abcdef');
    const verifier = scramVerifier('a password of its own', salt);
    const match = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(verifier);
    expect(match).not.toBeNull();
    const salted = pbkdf2Sync('a password of its own', salt, 4096, 32, 'sha256');
    const hmac = (data: string) => createHmac('sha256', salted).update(data).digest();
    expect(Buffer.from(match?.[1] ?? '', 'base64')).toEqual(salt);
    expect(match?.[2]).toBe(createHash('sha256').update(hmac('Client Key')).digest().toString('base64'));
    expect(match?.[3]).toBe(hmac('Server Key').toString('base64'));
  });

  it('uses a fresh salt each time, so the same password never gives the same verifier twice', () => {
    expect(scramVerifier('same password every time')).not.toBe(scramVerifier('same password every time'));
  });
});

describe('what setupDatabase sends to the server', () => {
  it('never puts a password in a statement or a parameter: only SCRAM verifiers, which the server may log', async () => {
    const { db, seen } = recorder();
    await setupDatabase(db, PASSWORDS);
    const everything = seen.map((s) => `${s.text} ${JSON.stringify(s.params)}`).join('\n');
    expect(everything).not.toContain(PASSWORDS.app);
    expect(everything).not.toContain(PASSWORDS.migrator);
    expect(everything).not.toContain(PASSWORDS.ops);
    expect(seen.filter((s) => /^(create|alter) role/.test(s.text)).map((s) => s.text.match(/password '(SCRAM-SHA-256\$[^']+)'/)?.[1] !== undefined)).toEqual([true, true, true]);
  });
});
