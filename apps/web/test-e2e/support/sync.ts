import type { Page } from '@playwright/test';

/** The attribute the editor's root element carries while it is connected: `data-collab-state="synced"` once the provider has synced. */
export const COLLAB_STATE_ATTRIBUTE = 'data-collab-state';

/** Waits for the provider state `synced` of the page's editor (never a fixed sleep). */
export async function waitForSynced(page: Page, options: { timeout?: number } = {}): Promise<void> {
  await page.waitForSelector(`[${COLLAB_STATE_ATTRIBUTE}="synced"]`, { state: 'attached', ...(options.timeout === undefined ? {} : { timeout: options.timeout }) });
}
