import { expect, test } from '@playwright/test';
import { scriptedApi, useScriptedApi } from '../editor/scripted';
import { scriptedCollabServer } from '../support/collab-server';
import { signInAs } from '../support/sign-in';
import { statusLine } from './support';

// "With the page cap at 1": the stack of the job has one fixed cap, so the server that holds the page is scripted: it takes the first browser and refuses the second
// with `page-full`, the way the real server does once the cap is reached. Each browser is told its server by its own scripted API.
test('the second browser, once the page is full, shows "This page already has 100 people editing. Try again in a moment."', async ({ browser, baseURL }) => {
  const first = await scriptedCollabServer();
  const second = await scriptedCollabServer({ onAuth: { deny: 'page-full' } });
  const apis = [await scriptedApi({ collabUrl: first.url }), await scriptedApi({ collabUrl: second.url })];
  const contexts = [await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) }), await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) })];
  try {
    const pages = [];
    for (const [i, context] of contexts.entries()) {
      await signInAs(context, `e2e-full-${i}`, 'member', { check: false });
      const page = await context.newPage();
      await useScriptedApi(page, apis[i]!);
      await page.goto('/p/scripted-abc123');
      pages.push(page);
    }
    await expect(statusLine(pages[1]!)).toHaveText('This page already has 100 people editing. Try again in a moment.');
    await expect(statusLine(pages[0]!)).not.toHaveText(/100 people/);
    expect(first.tokens).toHaveLength(1);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await Promise.all(apis.map((api) => api.stop()));
    await first.stop();
    await second.stop();
  }
});
