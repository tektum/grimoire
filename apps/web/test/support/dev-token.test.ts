// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildDevToken, DEV_TOKEN_MAX_LENGTH, DEV_TOKEN_PATTERN, DevTokenError, readDevSecret } from './dev-token';

// Made up from repeats, so the fixture does not look like a real key to a secret scanner.
const SECRET = 'ab12'.repeat(8);

describe('buildDevToken', () => {
  it('builds dev:<secret>:<userId>:<role> for each role, within the grammar and the length bound', () => {
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const token = buildDevToken(SECRET, 'alice_1-x', role);
      expect(token).toBe(`dev:${SECRET}:alice_1-x:${role}`);
      expect(token).toMatch(DEV_TOKEN_PATTERN);
      expect(token.length).toBeLessThanOrEqual(DEV_TOKEN_MAX_LENGTH);
    }
  });

  it('accepts the longest secret and user id the server accepts, and nothing longer overall', () => {
    expect(buildDevToken('s'.repeat(64), 'u'.repeat(64), 'admin')).toMatch(DEV_TOKEN_PATTERN);
    // 4 + 128 + 1 + 64 + 1 + 6 = 204: the grammar's own maximum is under the bound, so the bound is a second line of defence.
    expect(buildDevToken('s'.repeat(128), 'u'.repeat(64), 'viewer').length).toBe(204);
  });

  it.each(['Alice', 'ALICE', 'a b', 'a:b', '', 'é', 'a'.repeat(65), 'a.b'])('refuses the user id %j with a plain line', (userId) => {
    expect(() => buildDevToken(SECRET, userId, 'member')).toThrow(DevTokenError);
    expect(() => buildDevToken(SECRET, userId, 'member')).toThrow(/lowercase letters, digits, - or _/);
  });

  it('refuses an unknown role', () => {
    expect(() => buildDevToken(SECRET, 'alice', 'owner' as never)).toThrow('admin, member or viewer');
  });

  it('never puts the secret in an error message', () => {
    for (const run of [() => buildDevToken(SECRET, 'Alice', 'member'), () => buildDevToken(SECRET, 'alice', 'x' as never)]) {
      try {
        run();
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(SECRET);
      }
    }
  });
});

describe('readDevSecret', () => {
  it('prefers E2E_DEV_TOKEN_SECRET over the .env file', () => {
    expect(readDevSecret({ E2E_DEV_TOKEN_SECRET: SECRET }, `GRIMOIRE_DEV_TOKEN_SECRET=${'f'.repeat(24)}\n`)).toBe(SECRET);
  });
  it('reads GRIMOIRE_DEV_TOKEN_SECRET from the .env text when the variable is unset or empty', () => {
    const fromFile = '0123'.repeat(8);
    const file = `A=1\nGRIMOIRE_DEV_TOKEN_SECRET=${fromFile}\nB=2\n`;
    expect(readDevSecret({}, file)).toBe(fromFile);
    expect(readDevSecret({ E2E_DEV_TOKEN_SECRET: '' }, file)).toBe(fromFile);
  });
  it('fails with a line that names E2E_DEV_TOKEN_SECRET when there is no secret anywhere', () => {
    for (const file of [undefined, '', 'OTHER=1\n', 'GRIMOIRE_DEV_TOKEN_SECRET=\n']) {
      expect(() => readDevSecret({}, file)).toThrow(DevTokenError);
      expect(() => readDevSecret({}, file)).toThrow('E2E_DEV_TOKEN_SECRET');
    }
  });
  it('refuses a secret of the wrong shape without printing it', () => {
    const bad = 'short secret with spaces!';
    expect(() => readDevSecret({ E2E_DEV_TOKEN_SECRET: bad })).toThrow('16 to 128 characters');
    try {
      readDevSecret({ E2E_DEV_TOKEN_SECRET: bad });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(bad);
    }
  });
});
