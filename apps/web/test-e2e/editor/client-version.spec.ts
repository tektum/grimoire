import { expect, test } from '@playwright/test';
import { CLIENT_VERSION } from '../../src/version';
import { scriptedCollabServer } from '../support/collab-server';
import { signInAs } from '../support/sign-in';
import { traceHandshakes } from './handshakes';
import { SCRIPTED_PAGE_ID, scriptedApi, useScriptedApi } from './scripted';

test.describe('the client version in the handshake', () => {
  test('the token carries CLIENT_VERSION on every connect, the first and the ones after the server dropped the socket', async ({ browser, baseURL }) => {
    const collab = await scriptedCollabServer();
    const api = await scriptedApi({ collabUrl: collab.url });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-version', 'member', { check: false });
      const page = await context.newPage();
      const trace = traceHandshakes(page);
      const handshakes = trace.handshakes;
      await useScriptedApi(page, api);
      await page.goto('/p/scripted-abc123');
      await trace.waitFor(1, 15_000); // as long as before; a failure says whether the page opened no socket or a socket without a token, and what its console said
      collab.closeAll(1001, 'going away');
      await trace.waitFor(2, 30_000); // the automatic reconnect, as long as before
      for (const handshake of handshakes) expect(handshake.v).toBe(CLIENT_VERSION);
      expect(collab.documents.every((name) => name === SCRIPTED_PAGE_ID)).toBe(true);
    } finally {
      await context.close();
      await api.stop();
      await collab.stop();
    }
  });

  test('a client-too-old refusal shows "A new version is available. Reload." and the provider does not connect again', async ({ browser, baseURL }) => {
    const collab = await scriptedCollabServer({ onAuth: { deny: 'client-too-old' } });
    const api = await scriptedApi({ collabUrl: collab.url });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-version', 'member', { check: false });
      const page = await context.newPage();
      await page.clock.install(); // the waits of the page are the test's to move
      await useScriptedApi(page, api);
      await page.goto('/p/scripted-abc123');
      await expect(page.getByText('A new version is available. Reload.')).toBeVisible();
      await expect(page.getByTestId('editor-root')).toHaveAttribute('data-collab-state', 'stopped');
      expect(collab.tokens).toHaveLength(1);
      await page.clock.runFor(10 * 60_000); // ten minutes of the page's time: any retry would have fired
      expect(collab.tokens).toHaveLength(1);
    } finally {
      await context.close();
      await api.stop();
      await collab.stop();
    }
  });
});
