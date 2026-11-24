import type { Page, Route } from '@playwright/test';
import { bundleHarness } from '../collections/bundle';
import { fixtureServer } from '../support/fixtures';

/** A 1 by 1 PNG (a green pixel), enough for `naturalWidth` to be above 0. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/ZtqZ4wAAAABJRU5ErkJggg==', 'base64');
export const API = 'http://api.test';
export const FILES = 'http://files.test';
export const ID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
export const SECOND = '5a6b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

/** Every request the page made, by `METHOD url`, in order. */
export function logRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(`${request.method()} ${request.url()}`));
  return seen;
}

/**
 * The server side of the attachments of a page, scripted in the browser: `POST /v1/attachments/urls` answers a signed link for each id asked for (`links`), and each link
 * serves a PNG, except that a link listed in `refuse403` answers 403 once.
 */
export async function scriptStore(page: Page, options: { refuse403?: Set<string>; image?: { type: string; body: Buffer | string } } = {}) {
  const posted: string[][] = [];
  let issued = 0;
  await page.route(`${API}/**`, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const ids = (route.request().postDataJSON() as { ids: string[] }).ids;
    posted.push(ids);
    const urls = ids.map((id) => ({ id, url: `${FILES}/${id}.png?n=${(issued += 1)}`, expiresAt: Date.now() + 3_600_000 }));
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ urls }) });
  });
  const refused = options.refuse403 ?? new Set<string>();
  const served: string[] = [];
  await page.route(`${FILES}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const key = url.pathname.slice(1).replace('.png', '');
    served.push(`${key}?${url.searchParams.get('n')}`);
    if (refused.delete(key)) return route.fulfill({ status: 403, headers: cors, body: 'expired' });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': options.image?.type ?? 'image/png' }, body: options.image?.body ?? PNG });
  });
  return { posted, served };
}

/** The editor on `markdown` in a page of the spec's own server, asking `API` for links. `stop()` ends the server. */
export async function openPage(page: Page, markdown: string, options: { sans?: boolean; editable?: boolean } = {}) {
  const bundle = await bundleHarness('../attachments/harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page</title><main class="page" style="padding: 2rem 1rem"><div id="host"></div></main></html>' });
  await page.goto(server.url('/'));
  await page.addStyleTag({ content: bundle.css });
  // This machine's default sans-serif is a monospace face: an installed sans is named for the interface text only; the page text keeps its reading font.
  if (options.sans === true) await page.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" });
  // The slash menu's container is drawn as an empty bordered box in an editor that is not editable until its view has updated (the menu's own concern); the shots leave it out.
  if (options.sans === true) await page.addStyleTag({ content: '.slash-host:not([data-show="true"]) { display: none; }' });
  await page.addScriptTag({ content: bundle.js });
  await page.evaluate(([text, base, editable]) => (window as unknown as { harness: { mount: (m: string, a: string, e: boolean) => Promise<void> } }).harness.mount(text as string, base as string, editable as boolean), [markdown, API, options.editable === true]);
  return { origin: new URL(server.url('/')).origin, markdown: (): Promise<string> => page.evaluate(() => (window as unknown as { harness: { markdown: () => string } }).harness.markdown()), stop: () => server.stop() };
}
