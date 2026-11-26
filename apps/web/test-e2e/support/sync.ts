import { errors, test, type Page } from '@playwright/test';

/** The attribute the editor's root element carries while it is connected: `data-collab-state="synced"` once the provider has synced. */
export const COLLAB_STATE_ATTRIBUTE = 'data-collab-state';

/** A page syncs in a second or two; one that has not after this long is looked at (see `waitForSynced`). */
const FIRST_LOOK_MS = 30_000;

/** What the page shows now, for the report of a wait that is taking too long: never a token or a header, only the address, the state attributes, the headings and the first words. */
async function describePage(page: Page): Promise<string> {
  try {
    const seen = await page.evaluate((attribute) => ({
      url: window.location.pathname + window.location.search,
      states: [...document.querySelectorAll(`[${attribute}]`)].map((e) => e.getAttribute(attribute)),
      headings: [...document.querySelectorAll('h1, h2, [role="heading"]')].slice(0, 5).map((e) => (e.textContent ?? '').trim().slice(0, 80)),
      text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      ready: document.readyState,
    }), COLLAB_STATE_ATTRIBUTE);
    return JSON.stringify(seen, null, 2);
  } catch (error) {
    return `could not read the page: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
  }
}

/**
 * Waits for the provider state `synced` of the page's editor (never a fixed sleep). With no `timeout` it waits as long as the test lets it, as it always did; but
 * once `diagnoseAfter` (30 s) has passed it attaches what the page shows to the report (`not-synced-yet.txt`) and goes on waiting: a test that ends on this wait
 * says what the page was doing, which the end of a test cannot.
 */
export async function waitForSynced(page: Page, options: { timeout?: number; diagnoseAfter?: number } = {}): Promise<void> {
  const selector = `[${COLLAB_STATE_ATTRIBUTE}="synced"]`;
  if (options.timeout !== undefined) {
    await page.waitForSelector(selector, { state: 'attached', timeout: options.timeout });
    return;
  }
  try {
    await page.waitForSelector(selector, { state: 'attached', timeout: options.diagnoseAfter ?? FIRST_LOOK_MS });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    await test.info().attach('not-synced-yet.txt', { body: await describePage(page), contentType: 'text/plain' });
    await page.waitForSelector(selector, { state: 'attached' });
  }
}
