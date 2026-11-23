import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import { defaultOrigins, freshKey, runtimeStore, setCors, startServer, type PageServer } from './support.js';

const store = runtimeStore();
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const created: string[] = [];
let allowed: PageServer; // the page whose origin the bucket's CORS rule lists
let other: PageServer; // a page whose origin it does not

test.beforeAll(async () => {
  allowed = await startServer();
  other = await startServer();
  await setCors([allowed.origin]);
});
test.afterAll(async () => {
  for (const key of created) await store.delete(key);
  await setCors(defaultOrigins);
  await allowed.close();
  await other.close();
});

interface Sent {
  readonly status?: number;
  readonly error?: string;
}
/** What the page's own script does with a signed upload: a `fetch` PUT, which a browser sends only if CORS allows. */
async function putFrom(
  page: Page,
  signed: { url: string; headers: Record<string, string> },
  body: Uint8Array,
  headers: Record<string, string> = signed.headers,
): Promise<Sent> {
  return page.evaluate(
    async ({ url, sentHeaders, bytes }) => {
      try {
        const response = await fetch(url, { method: 'PUT', headers: sentHeaders, body: new Uint8Array(bytes) });
        return { status: response.status };
      } catch (error) {
        return { error: String(error) };
      }
    },
    { url: signed.url, sentHeaders: headers, bytes: [...body] },
  );
}
const sign = (key: string, size: number, contentType = 'image/png') => {
  created.push(key);
  return store.signUpload(key, { size, contentType, ttlSeconds: 120, ifNoneMatch: true });
};
const absent = async (key: string): Promise<boolean> => {
  try {
    await store.head(key);
    return false;
  } catch (error) {
    return error instanceof FileStorageError && error.kind === 'not-found';
  }
};

test.describe('the file store from a real browser', () => {
  test('a PUT from an allowed origin succeeds', async ({ page }) => {
    await page.goto(allowed.origin);
    const key = freshKey();
    const body = text('0123456789');
    const sent = await putFrom(page, await sign(key, body.length), body);
    expect(sent).toEqual({ status: 200 });
    expect((await store.head(key)).size).toBe(body.length);
  });

  test('a PUT from another origin fails at the preflight and the object is absent', async ({ page }) => {
    await page.goto(other.origin);
    const key = freshKey();
    const body = text('0123456789');
    const sent = await putFrom(page, await sign(key, body.length), body);
    expect(sent.status).toBeUndefined();
    expect(sent.error).toContain('Failed to fetch');
    expect(await absent(key)).toBe(true);
  });

  test('a different size or type is rejected by the store and the object is absent', async ({ page }) => {
    await page.goto(allowed.origin);
    const key = freshKey();
    const signed = await sign(key, 10);
    for (const body of [text('012345678901'), text('01234')]) {
      const sent = await putFrom(page, signed, body);
      expect(sent.status).toBeGreaterThanOrEqual(400);
      expect(await absent(key)).toBe(true);
    }
    const wrongType = await putFrom(page, signed, text('0123456789'), {
      ...signed.headers,
      'content-type': 'text/html',
    });
    expect(wrongType.status).toBeGreaterThanOrEqual(400);
    expect(await absent(key)).toBe(true);
  });

  test('a second PUT gets 412 and the first object is unchanged', async ({ page }) => {
    await page.goto(allowed.origin);
    const key = freshKey();
    const first = text('0123456789');
    expect(await putFrom(page, await sign(key, first.length), first)).toEqual({ status: 200 });
    const before = await store.head(key);
    const second = text('abcdefghij');
    expect(await putFrom(page, await sign(key, second.length), second)).toEqual({ status: 412 });
    expect(await store.head(key)).toEqual(before);
    const got = await store.get(key);
    let bytes = '';
    for await (const part of got.body) bytes += new TextDecoder().decode(part);
    expect(bytes).toBe('0123456789');
  });

  test('the download URL of HTML stored as text/plain gives a download, not a page', async ({ page }) => {
    await page.goto(allowed.origin);
    const key = freshKey();
    created.push(key);
    const html = text('<!doctype html><script>window.__ran = 1</script><h1>not a page</h1>');
    await store.put(key, html, { size: html.length, contentType: 'text/plain' });
    const { url } = await store.signDownload(key, { ttlSeconds: 120, disposition: 'attachment', fileName: 'note.txt' });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(`window.location.href = ${JSON.stringify(url)}`),
    ]);
    expect(download.suggestedFilename()).toBe('note.txt');
    expect(readFileSync((await download.path()) as string, 'utf8')).toBe(new TextDecoder().decode(html));
    expect(page.url()).toBe(`${allowed.origin}/`);
    expect(await page.evaluate('window.__ran')).toBeUndefined();
  });

  test('a GIF with HTML after the header, declared image/gif, is shown as image/gif and runs no script', async ({
    page,
  }) => {
    const key = freshKey();
    created.push(key);
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
    await store.put(key, gif, { size: gif.length, contentType: 'image/gif' });
    const { url } = await store.signDownload(key, { ttlSeconds: 120, disposition: 'inline', contentType: 'image/gif' });
    const response = await page.goto(url);
    expect(response?.headers()['content-type']).toMatch(/^image\/gif/);
    expect(await page.evaluate('document.contentType')).toBe('image/gif');
    expect(await page.evaluate('window.__ran')).toBeUndefined();
  });
});
