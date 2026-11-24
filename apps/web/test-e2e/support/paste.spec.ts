import { expect, test } from '@playwright/test';
import { fixtureServer, type FixtureServer } from './fixtures';
import { pasteIntoEditor } from './paste';

// The helper that pastes into the editor in every specification, tried on small pages (no stack): it delivers files, HTML and text in every engine, and it fails with a plain line when
// the event reaches no one, so that a check made through it cannot pass with nothing pasted.
let server: FixtureServer;

const PAGE = (script = ''): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div class="ProseMirror" contenteditable="true">text</div><p id="got"></p><script>
    document.querySelector('.ProseMirror').addEventListener('paste', (e) => { document.getElementById('got').textContent = JSON.stringify({ files: Array.from(e.clipboardData.files).map((f) => f.name + ':' + f.size + ':' + f.type), html: e.clipboardData.getData('text/html'), text: e.clipboardData.getData('text/plain') }); });
    ${script}
  </script></body></html>`;

test.beforeAll(async () => {
  server = await fixtureServer({ '/editor': PAGE(), '/swallowed': PAGE("document.addEventListener('paste', (e) => e.stopImmediatePropagation(), true);") });
});
test.afterAll(async () => server.stop());

test('files, HTML and text reach the editor as the page reads them, in every engine', async ({ page }) => {
  await page.goto(server.url('/editor'));
  const seen = await pasteIntoEditor(page, {
    files: [
      { name: 'a.png', type: 'image/png', bytes: 5 },
      { name: 'b.txt', type: 'text/plain', base64: 'aGk=' },
    ],
    html: '<p>x</p>',
    text: 'x',
  });
  expect(seen).toEqual({ files: 2, types: expect.arrayContaining(['Files', 'text/html', 'text/plain']) });
  expect(JSON.parse((await page.locator('#got').textContent()) ?? '')).toEqual({ files: ['a.png:5:image/png', 'b.txt:2:text/plain'], html: '<p>x</p>', text: 'x' });
});

test('a paste that carries nothing to the page fails with a plain line, instead of passing', async ({ page }) => {
  await page.goto(server.url('/swallowed'));
  await expect(pasteIntoEditor(page, { html: '<p>x</p>' })).rejects.toThrow(/the paste carried no data in this engine: the page saw -1 file\(s\)/);
  expect(await page.locator('#got').textContent(), 'and the editor did not get it').toBe('');
});
