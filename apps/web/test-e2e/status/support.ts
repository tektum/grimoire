import type { Browser, Page } from '@playwright/test';
import { scriptedApi, useScriptedApi } from '../editor/scripted';
import { scriptedCollabServer, type ScriptedCollabServer, type ScriptedCollabServerOptions } from '../support/collab-server';
import { signInAs } from '../support/sign-in';

/** The line the page keeps for its status: the one polite live region. */
export const statusLine = (page: Page) => page.locator('p.page-status[role="status"]');

/**
 * The page screen on a scripted API and a scripted collaboration server (real loopback origins; the page's clock is the test's: `page.clock`), for the rows a real
 * server cannot be made to produce. The page is open when `body` runs; everything is stopped after.
 */
export async function withScriptedPage(
  browser: Browser,
  baseURL: string | undefined,
  options: ScriptedCollabServerOptions,
  body: (run: { page: Page; collab: ScriptedCollabServer }) => Promise<void>,
): Promise<void> {
  const collab = await scriptedCollabServer(options);
  const api = await scriptedApi({ collabUrl: collab.url });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-status', 'member', { check: false });
    const page = await context.newPage();
    await page.clock.install();
    await useScriptedApi(page, api);
    await page.goto('/p/scripted-abc123');
    await body({ page, collab });
  } finally {
    await context.close();
    await api.stop();
    await collab.stop();
  }
}
