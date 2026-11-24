import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const config = readFileSync(`${root}apps/web/playwright.config.ts`, 'utf8');
const excluded = /testIgnore: FIREFOX_ARIA_CRASH_SPECS/.test(config);
const firefox = JSON.parse(readFileSync(`${root}node_modules/playwright-core/browsers.json`, 'utf8')).browsers.find((b) => b.name === 'firefox');
const major = Number.parseInt(firefox.browserVersion, 10);

test('the Firefox exclusion is one rule, with its reason, on the firefox project only', () => {
  assert.equal((config.match(/FIREFOX_ARIA_CRASH_SPECS/g) ?? []).length, 2, 'defined once and used once');
  assert.match(config, /Playwright issue 44135, Mozilla bug\s+\* 2090055 \(fixed in Firefox 163\)/);
  assert.match(config, /name: 'firefox'[^\n]*testIgnore: FIREFOX_ARIA_CRASH_SPECS/);
  assert.doesNotMatch(config, /name: '(chromium|webkit)'[^\n]*testIgnore/);
  assert.match(config, /\/axe\\\.spec\\\.ts\$\//);
  assert.match(config, /a11y\\\/\(\?!proof\\\.spec\|support\\\.spec\)/);
});

test('the exclusion ends with the Firefox that fixes the crash: from 163, take it out', () => {
  assert.ok(Number.isInteger(major), `the Firefox of the installed Playwright has a version (${firefox.browserVersion})`);
  if (major >= 163) assert.fail(`the Firefox of the installed Playwright is ${firefox.browserVersion}, which has the fix (Mozilla bug 2090055): remove FIREFOX_ARIA_CRASH_SPECS from apps/web/playwright.config.ts`);
  assert.ok(excluded, 'and until then it is in place');
});
