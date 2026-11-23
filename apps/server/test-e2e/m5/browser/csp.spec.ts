import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  filesConfig,
  freshKey,
  runtimeStore,
  setCors,
  startServer,
  defaultOrigins,
  type PageServer,
} from './support.js';

// The page carries the Content-Security-Policy of the shape the application will render (R12.10): `connect-src` and
// `img-src` are the page itself and the store's public origin, nothing else.
const store = runtimeStore();
const storeOrigin = filesConfig().publicOrigin;
const created: string[] = [];
let page_: PageServer; // the page, with the policy; its origin is in the bucket's CORS rule
let third: PageServer; // an origin the policy does not list

test.beforeAll(async () => {
  page_ = await startServer({
    csp: `default-src 'self'; connect-src 'self' ${storeOrigin}; img-src 'self' ${storeOrigin}`,
  });
  third = await startServer();
  await setCors([page_.origin]);
});
test.afterAll(async () => {
  for (const key of created) await store.delete(key);
  await setCors(defaultOrigins);
  await page_.close();
  await third.close();
});

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A valid 1x1 PNG, built here. */
function png(): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Records the policy violations the page reports, from before the page's own scripts run. */
async function openPage(page: Page): Promise<void> {
  await page.addInitScript(`
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
  `);
  await page.goto(page_.origin);
}
const violations = async (page: Page): Promise<string[]> => (await page.evaluate('window.__violations')) as string[];

test.describe('the file store under the application’s Content-Security-Policy', () => {
  test('the signed PUT to the store succeeds, and a PUT to a third origin is blocked by the policy', async ({
    page,
  }) => {
    await openPage(page);
    const key = freshKey();
    created.push(key);
    const body = text('0123456789');
    const signed = await store.signUpload(key, {
      size: body.length,
      contentType: 'image/png',
      ttlSeconds: 120,
      ifNoneMatch: true,
    });
    const put = (url: string, headers: Record<string, string>) =>
      page.evaluate(
        async ({ target, sent, bytes }) => {
          try {
            return {
              status: (await fetch(target, { method: 'PUT', headers: sent, body: new Uint8Array(bytes) })).status,
            };
          } catch (error) {
            return { error: String(error) };
          }
        },
        { target: url, sent: headers, bytes: [...body] },
      );
    expect(await put(signed.url, signed.headers)).toEqual({ status: 200 });
    expect(await violations(page)).toEqual([]);
    const blocked = await put(`${third.origin}/upload`, {});
    expect(blocked.error).toContain('Failed to fetch');
    expect((await violations(page)).some((v) => v.startsWith('connect-src') && v.includes(third.origin))).toBe(true);
    expect(third.hits.filter((hit) => hit.startsWith('PUT'))).toEqual([]);
  });

  test('an image from a signed download URL displays in an <img>, and a script-bearing GIF declared image/gif runs nothing', async ({
    page,
  }) => {
    await openPage(page);
    const image = png();
    const imageKey = freshKey();
    const gifKey = freshKey();
    created.push(imageKey, gifKey);
    await store.put(imageKey, image, { size: image.length, contentType: 'image/png' });
    const gif = new Uint8Array([
      ...text('GIF89a'),
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      0x3b,
      ...text('<script>window.__ran = 1</script>'),
    ]);
    await store.put(gifKey, gif, { size: gif.length, contentType: 'image/gif' });
    const shown = await store.signDownload(imageKey, {
      ttlSeconds: 120,
      disposition: 'inline',
      contentType: 'image/png',
    });
    const hostile = await store.signDownload(gifKey, {
      ttlSeconds: 120,
      disposition: 'inline',
      contentType: 'image/gif',
    });
    const load = (url: string) =>
      page.evaluate(`new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ ok: true, width: img.naturalWidth });
        img.onerror = () => resolve({ ok: false, width: 0 });
        img.src = ${JSON.stringify(url)};
        document.body.append(img);
      })`) as Promise<{ ok: boolean; width: number }>;
    const result = await load(shown.url);
    expect(result).toEqual({ ok: true, width: 1 });
    await load(hostile.url);
    expect(await page.evaluate('window.__ran')).toBeUndefined();
    expect(await violations(page)).toEqual([]);
  });
});
