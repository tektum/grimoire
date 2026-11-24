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

export interface StoreOptions {
  readonly refuse403?: Set<string>;
  readonly image?: { type: string; body: Buffer | string };
  /** Answers a create: the status for the n-th create (1 for the first); default 201. Errors carry the code of the status (413 too_large, 422 type_not_allowed, 429 rate_limited). */
  readonly createStatus?: (n: number) => number;
  /** Holds every PUT to the store until the promise is settled (an upload in progress). */
  readonly holdPut?: Promise<void>;
}

const CODES: Record<number, string> = { 413: 'too_large', 422: 'type_not_allowed', 429: 'rate_limited', 500: 'internal' };

/**
 * The server side of the attachments of a page, scripted in the browser. The API (`API`): `POST /v1/attachments` (create), `POST /v1/attachments/urls` (a signed link for
 * each id asked for), `POST /v1/attachments/{id}/complete`, `GET /v1/attachments/{id}` (a signed link). The store (`FILES`): `PUT /put/<id>` takes the bytes, every
 * other path serves a PNG, except that a link listed in `refuse403` answers 403 once. `log` is every request to either, in order, as `METHOD path`; `puts` the headers of each PUT.
 */
export async function scriptStore(page: Page, options: StoreOptions = {}) {
  const posted: string[][] = [];
  const log: string[] = [];
  const puts: Record<string, string>[] = [];
  let issued = 0;
  let created = 0;
  const made = new Map<string, { fileName: string; contentType: string }>();
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => ({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  await page.route(`${API}/**`, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    log.push(`${request.method()} ${path}`);
    if (path === '/v1/attachments/urls') {
      const ids = (request.postDataJSON() as { ids: string[] }).ids;
      posted.push(ids);
      return route.fulfill(json(200, { urls: ids.map((id) => ({ id, url: `${FILES}/${id}.png?n=${(issued += 1)}`, expiresAt: Date.now() + 3_600_000 })) }));
    }
    if (path === '/v1/attachments' && request.method() === 'POST') {
      created += 1;
      const status = options.createStatus?.(created) ?? 201;
      if (status !== 201) return route.fulfill(json(status, { error: { code: CODES[status] ?? 'internal', message: 'refused' } }, {}));
      const body = request.postDataJSON() as { fileName: string; contentType: string; size: number; pageId: string };
      const id = `00000000-0000-4000-8000-${String(created).padStart(12, '0')}`;
      const name = encodeURIComponent(body.fileName);
      made.set(id, { fileName: body.fileName, contentType: body.contentType });
      return route.fulfill(
        json(201, {
          id,
          markdownPath: `attachments/${id}/${name}`,
          upload: { method: 'PUT', url: `${FILES}/put/${id}`, headers: { 'content-type': body.contentType, 'if-none-match': '*' }, expiresAt: Date.now() + 600_000 },
        }),
      );
    }
    const complete = /^\/v1\/attachments\/([^/]+)\/complete$/.exec(path);
    if (complete !== null)
      return route.fulfill(
        json(200, {
          id: complete[1],
          ...made.get(complete[1]!),
          size: 1,
          markdownPath: `attachments/${complete[1]}/${encodeURIComponent(made.get(complete[1]!)?.fileName ?? 'x')}`,
          pageId: '99999999-8888-4777-8666-555555555555',
        }),
      );
    if (/^\/v1\/attachments\/[^/]+$/.test(path)) return route.fulfill(json(200, { url: `${FILES}/download/${path.split('/').pop()}?sig=1`, expiresAt: Date.now() + 60_000 }));
    return route.fulfill(json(404, { error: { code: 'not_found', message: 'no' } }));
  });
  const refused = options.refuse403 ?? new Set<string>();
  const served: string[] = [];
  await page.route(`${FILES}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (request.method() === 'PUT') {
      log.push(`PUT ${url.origin}${url.pathname}`);
      puts.push(request.headers());
      await options.holdPut;
      return route.fulfill({ status: 200, headers: cors });
    }
    const key = url.pathname.slice(1).replace('.png', '');
    served.push(`${key}?${url.searchParams.get('n')}`);
    if (refused.delete(key)) return route.fulfill({ status: 403, headers: cors, body: 'expired' });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': options.image?.type ?? 'image/png' }, body: options.image?.body ?? PNG });
  });
  return { posted, served, log, puts };
}

/** The editor on `markdown` in a page of the spec's own server, asking `API` for links. `stop()` ends the server. */
export async function openPage(page: Page, markdown: string, options: { sans?: boolean; editable?: boolean } = {}) {
  const bundle = await bundleHarness('../attachments/harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page</title><main class="page" style="padding: 2rem 1rem"><div id="host"></div></main></html>' });
  await page.goto(server.url('/'));
  await page.addStyleTag({ content: bundle.css });
  // This machine's default sans-serif is a monospace face: an installed sans is named for the interface text only; the page text keeps its reading font.
  if (options.sans === true) await page.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" });
  await page.addScriptTag({ content: bundle.js });
  await page.evaluate(
    ([text, base, editable]) => (window as unknown as { harness: { mount: (m: string, a: string, e: boolean) => Promise<void> } }).harness.mount(text as string, base as string, editable as boolean),
    [markdown, API, options.editable === true],
  );
  return { origin: new URL(server.url('/')).origin, markdown: (): Promise<string> => page.evaluate(() => (window as unknown as { harness: { markdown: () => string } }).harness.markdown()), stop: () => server.stop() };
}

/** Pastes a file into the editor, as the clipboard of a browser carries it. */
export async function pasteFiles(page: Page, files: { name: string; type: string; bytes?: number }[]): Promise<void> {
  await page.locator('.ProseMirror').click();
  await page.evaluate((list) => {
    const data = new DataTransfer();
    for (const file of list) data.items.add(new File([new Uint8Array(file.bytes ?? 3)], file.name, { type: file.type }));
    // The data goes on the event as a property: Firefox gives an event made by a script an empty clipboard whatever it is made with, and every engine reads the property the same way.
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    document.querySelector('.ProseMirror')!.dispatchEvent(event);
  }, files);
}
