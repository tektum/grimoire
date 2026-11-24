import type { Page } from '@playwright/test';
import { bundleHarness } from '../collections/bundle';
import { fixtureServer } from '../support/fixtures';

/** The editor on `markdown`, editable, in a page of the spec's own server, without the stack. `stop()` ends the server. */
export async function openEditor(page: Page, markdown: string, options: { sans?: boolean } = {}) {
  const bundle = await bundleHarness('../tables/harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><html lang="en"><meta charset="utf-8"><title>Editor</title><main class="page" style="padding: 2rem 1rem"><div id="host"></div></main></html>' });
  await page.goto(server.url('/'));
  await page.addStyleTag({ content: bundle.css });
  // This machine's default sans-serif is a monospace face: an installed sans is named for the interface text, the page text keeps its reading font.
  if (options.sans === true) await page.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" });
  await page.addScriptTag({ content: bundle.js });
  await page.evaluate((text) => (window as unknown as { harness: { mount: (m: string) => Promise<void> } }).harness.mount(text), markdown);
  return {
    markdown: (): Promise<string> => page.evaluate(() => (window as unknown as { harness: { markdown: () => string } }).harness.markdown()),
    stop: () => server.stop(),
  };
}
