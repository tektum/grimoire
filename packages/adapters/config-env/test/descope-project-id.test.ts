import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/index.js';

const base = {
  GRIMOIRE_DEV_TOKEN_SECRET: ['test', 'secret', '0123456789abcdef'].join('-'), // joined so that no secret-looking literal sits in the file
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
  GRIMOIRE_LOCAL: '0',
  GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test',
};
const projectIdIssue = (id: string): string | undefined => {
  try {
    loadConfig({ ...base, GRIMOIRE_DESCOPE_PROJECT_ID: id });
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.issues.find((i) => i.startsWith('GRIMOIRE_DESCOPE_PROJECT_ID:'));
  }
  return undefined;
};

it.each(['P1-foo', 'P1_foo', 'x'.repeat(129)])('a printable project id with anything but letters and digits names the setting and the rule: %s', (id) => {
  expect(projectIdIssue(id)).toMatch(/^GRIMOIRE_DESCOPE_PROJECT_ID: .*letters and digits/);
});

it.each(['P1 foo', 'P1é'])('a project id with a space or a non-ASCII character is refused too, under the same setting: %s', (id) => {
  expect(projectIdIssue(id)).toMatch(/^GRIMOIRE_DESCOPE_PROJECT_ID: /);
});

it('a project id of letters and digits is accepted', () => {
  expect(projectIdIssue('P2testprojectidabcdefghijkl')).toBeUndefined();
});
