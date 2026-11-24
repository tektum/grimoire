import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';
import { historyApi, SLUG, type MockRevision } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'history-specs-secret-0000001';

// Screenshots of the history screens, light and dark, 1280 by 800, from the built client with the stand-in API (test-results/shots/M6-T07/). This machine's default
// sans-serif is a monospace face, so an installed sans (Liberation Sans) is named for the interface text, as in the other shots.
const TASK = 'M6-T07';
const SANS = ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; --font-page: 'Liberation Sans', Arial, sans-serif; }";
const at = (day: number, hour: number, minute: number) => Date.UTC(2026, 10, day, hour, minute);
const alice = { id: 'u1', name: 'Alice Example' };
const bob = { id: 'u2', name: 'Bob Builder' };
const revision = (id: string, createdAt: number, reason: MockRevision['reason'], over: Partial<MockRevision> = {}): MockRevision => ({
  id,
  createdAt,
  title: 'Quarterly plan',
  reason,
  lastAuthor: alice,
  authors: [alice, bob],
  markdown: '# Quarterly plan\n\n## Goals\n\nShip the history screens.\n\n- Write the tests\n- Review the diff\n\n## Notes\n\nThe older wording of this paragraph.\n',
  ...over,
});
const STATE = {
  role: 'member' as const,
  current: '# Quarterly plan\n\n## Goals\n\nShip the history screens and the restore.\n\n- Write the tests\n- Review the diff\n- Announce it\n\n## Notes\n\nThe newer wording of this paragraph.\n',
  revisions: [
    revision('r3', at(21, 16, 42), 'last_editor_left'),
    revision('r2', at(21, 11, 5), 'before_restore', { lastAuthor: bob, authors: [bob] }),
    revision('r1', at(20, 14, 30), 'idle', { lastAuthor: alice, authors: [alice] }),
  ],
};

test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium'); });

test('the revision list, light and dark', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await historyApi(page, STATE);
  await page.goto(`/p/${SLUG}/history`);
  await page.addStyleTag({ content: SANS });
  await expect(page.getByRole('listitem')).toHaveCount(3);
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'list');
});

test('one revision, light and dark', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await historyApi(page, STATE);
  await page.goto(`/p/${SLUG}/history/r3`);
  await page.addStyleTag({ content: SANS });
  await expect(page.getByTestId('revision-text').locator('.ProseMirror')).toContainText('The older wording');
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'revision');
});

test('the line diff with added and removed lines, light and dark', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await historyApi(page, STATE);
  await page.goto(`/p/${SLUG}/history/r3`);
  await page.addStyleTag({ content: SANS });
  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.getByRole('tabpanel').locator('ins').first()).toBeVisible();
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'diff');
});
