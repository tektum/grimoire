// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');
const overlay = readFileSync(path.join(root, 'compose.m6.yaml'), 'utf8');
const settings = readFileSync(path.join(root, 'packages/adapters/config-env/src/schema.ts'), 'utf8');
const lines = overlay.split('\n').filter((l) => !l.trimStart().startsWith('#'));

/** `NAME: "value"` lines of the overlay's environment block, as name -> value. */
const environment = Object.fromEntries(lines.flatMap((l) => (l.match(/^\s{6}(\w+): "(.*)"$/) ? [[l.trim().split(':')[0]!, l.match(/"(.*)"$/)![1]!]] : [])));

describe('compose.m6.yaml', () => {
  it("allows the two origins of the static server on port 4173 as well as the plain stack's own, and only the app service is touched", () => {
    // 4173 is the default of E2E_WEB_PORT, the port of the static server (E2E_WEB_PORT in the Playwright configuration moves both).
    expect(environment['GRIMOIRE_ALLOWED_ORIGINS']).toBe('http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:${E2E_WEB_PORT:-4173},http://localhost:${E2E_WEB_PORT:-4173}');
    expect(lines.filter((l) => /^ {2}\w/.test(l)).map((l) => l.trim())).toEqual(['app:']);
    expect(lines.some((l) => /^services:/.test(l))).toBe(true);
  });

  it('has a dedicated M6_* variable for each setting, so a value in .env cannot override the overlay', () => {
    const mapping = {
      GRIMOIRE_MIN_CLIENT_VERSION: ['M6_MIN_CLIENT_VERSION', '0.0.0', "'0.0.0'"],
      GRIMOIRE_REQUIRE_HANDSHAKE: ['M6_REQUIRE_HANDSHAKE', '0', "'0'"],
      GRIMOIRE_COLLAB_RECHECK_SECONDS: ['M6_RECHECK_SECONDS', '60', '60'],
      GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE: ['M6_MAX_CONNECTIONS_PER_PAGE', '100', '100'],
    } as const;
    for (const [setting, [variable, fallback, inSettings]] of Object.entries(mapping)) {
      expect([setting, environment[setting]]).toEqual([setting, `\${${variable}:-${fallback}}`]);
      // Each default equals the default the settings loader applies, so the overlay changes nothing on its own.
      const line = settings.split('\n').find((l) => l.trimStart().startsWith(`${setting}: field(`)) ?? '';
      expect([setting, line.trimEnd().endsWith(`.default(${inSettings}),`)]).toEqual([setting, true]);
    }
  });

  it('never names a plain GRIMOIRE_ setting through its own variable (that is the .env trap)', () => {
    for (const value of Object.values(environment)) expect(value).not.toMatch(/\$\{GRIMOIRE_/);
  });
});
