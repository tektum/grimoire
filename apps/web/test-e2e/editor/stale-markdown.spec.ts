import { expect, test } from '@playwright/test';
import { scriptedCollabServer } from '../support/collab-server';
import { signInAs } from '../support/sign-in';
import { scriptedApi, useScriptedApi } from './scripted';

test.describe('a saved text that may lag', () => {
  test('a page flagged stale says so in the read-only first view', async ({ browser, baseURL }) => {
    const collab = await scriptedCollabServer();
    const api = await scriptedApi({ collabUrl: collab.url, stale: true });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-stale', 'member', { check: false });
      const page = await context.newPage();
      await useScriptedApi(page, api);
      await page.goto('/p/scripted-abc123');
      await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
      await expect(page.getByText('The saved text of the scripted page.')).toBeVisible();
      await expect(page.getByText('This text may be a few seconds behind the live page.')).toBeVisible();
    } finally {
      await context.close();
      await api.stop();
      await collab.stop();
    }
  });

  test('a page that is not flagged does not say it', async ({ browser, baseURL }) => {
    const collab = await scriptedCollabServer();
    const api = await scriptedApi({ collabUrl: collab.url });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-stale', 'member', { check: false });
      const page = await context.newPage();
      await useScriptedApi(page, api);
      await page.goto('/p/scripted-abc123');
      await expect(page.getByText('The saved text of the scripted page.')).toBeVisible();
      await expect(page.getByText('This text may be a few seconds behind the live page.')).toHaveCount(0);
    } finally {
      await context.close();
      await api.stop();
      await collab.stop();
    }
  });
});
