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
  /** Runs before the page is opened: routes that change what the scripted API says. */
  beforeOpen: (page: Page) => Promise<void> = async () => undefined,
): Promise<void> {
  const collab = await scriptedCollabServer(options);
  const api = await scriptedApi({ collabUrl: collab.url });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-status', 'member', { check: false });
    const page = await context.newPage();
    await page.clock.install();
    await useScriptedApi(page, api);
    await beforeOpen(page);
    await page.goto('/p/scripted-abc123');
    await body({ page, collab });
  } finally {
    await context.close();
    await api.stop();
    await collab.stop();
  }
}

/**
 * Makes the collaboration server slow to answer: everything it sends reaches the page `ms` later. DESIGN.md ("Save status"): "Saving" shows only when a save takes longer than 400ms, so a
 * test that looks for it needs a server that is not fast. Call it before the page is opened.
 */
export async function slowServer(page: Page, ms = 900): Promise<void> {
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    const pending = new Set<ReturnType<typeof setTimeout>>();
    const stop = (): void => {
      for (const timer of pending) clearTimeout(timer); // nothing is sent into a socket that has closed
      pending.clear();
    };
    ws.onMessage((message) => { server.send(message); });
    server.onMessage((message) => {
      const timer = setTimeout(() => {
        pending.delete(timer);
        ws.send(message);
      }, ms);
      pending.add(timer);
    });
    ws.onClose(() => { stop(); void server.close(); });
    server.onClose(() => { stop(); void ws.close(); });
  });
}
