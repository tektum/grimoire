import { expect, test, type Page } from '@playwright/test';
import { isSafeHref } from '../../src/safety';
import { xssCorpus } from '../../test/corpus/xss';
import { bundleHarness } from '../collections/bundle';
import { fixtureServer } from '../support/fixtures';
import { pasteIntoEditor } from '../support/paste';

// HTML pasted into the editor goes through DOMPurify with an allow-list before the editor reads it (contracts section 8, rule 3). This runs in a real browser, because the
// sanitiser's work is the browser's parser's; the unit tests check what it is told.
const pasted = xssCorpus.filter((entry) => entry.html !== undefined && (entry.expect === 'sanitised' || entry.expect === 'image-blocked'));

async function open(page: Page) {
  const bundle = await bundleHarness('../safety/paste-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>Grimoire</title><div id="host"></div>' });
  const dialogs: string[] = [];
  const requests: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(server.url('/'));
  await page.addStyleTag({ content: bundle.css });
  await page.addScriptTag({ content: bundle.js });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  return {
    dialogs,
    offOrigin: () => requests.filter((u) => !u.startsWith(server.url('/')) && !u.startsWith('data:') && !u.startsWith('blob:')),
    markdown: (): Promise<string> => page.evaluate(() => (window as unknown as { harness: { markdown: () => string } }).harness.markdown()),
    stop: () => server.stop(),
  };
}

/** Pastes this HTML into a new empty paragraph at the end of the document, as a browser's clipboard carries it (`text/html`, and the text of it as `text/plain`). */
async function paste(page: Page, html: string): Promise<void> {
  await page.locator('.ProseMirror').click();
  await page.evaluate(() => (window as unknown as { harness: { forget: () => void } }).harness.forget());
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); // a paragraph of its own: blocks pasted into the end of a line would be joined to it
  await pasteIntoEditor(page, { html, textOfHtml: true });
}

test.describe('HTML pasted into the editor', () => {
  for (const entry of pasted) {
    test(`${entry.id}: nothing active reaches the page, no request leaves it, no dialog opens`, async ({ page }) => {
      const opened = await open(page);
      try {
        await paste(page, entry.html!);
        await page.waitForTimeout(200); // what an element made by the paste would do (load, error) has had its time
        const found = await page.evaluate(() => {
          const surface = document.querySelector('.ProseMirror')!;
          const elements = [...surface.querySelectorAll('*')];
          return {
            tags: elements.map((e) => e.tagName.toLowerCase()),
            attributes: elements.flatMap((e) => e.getAttributeNames().filter((a) => /^on/i.test(a) || a === 'style' || a === 'srcdoc' || a === 'formaction' || a.includes('xlink'))),
            links: [...surface.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? ''),
            pwned: (window as unknown as { __pwned?: unknown }).__pwned,
          };
        });
        for (const bad of ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'style', 'link', 'meta', 'base', 'svg', 'math', 'template', 'input', 'button', 'video', 'audio'])
          expect([entry.id, bad, found.tags.includes(bad)]).toEqual([entry.id, bad, false]);
        expect(found.attributes).toEqual([]);
        for (const href of found.links) expect([entry.id, href, isSafeHref(href)]).toEqual([entry.id, href, true]);
        expect(found.pwned).toBeUndefined();
        expect(opened.dialogs).toEqual([]);
        expect(opened.offOrigin()).toEqual([]);
        // What the editor was handed to read: the paste with the active parts already taken out, not only what the schema made of it.
        const handed = await page.evaluate(() => (window as unknown as { harness: { parsed: () => string[] } }).harness.parsed().join('\n'));
        for (const bad of ['<script', '<iframe', '<form', '<style', '<object', '<embed', '<svg', '<math', ' onerror', ' onclick', ' onload', ' onfocus', ' ontoggle', ' style=', 'javascript:', 'srcdoc'])
          expect([entry.id, bad, handed.toLowerCase().includes(bad)]).toEqual([entry.id, bad, false]);
        const markdown = await opened.markdown();
        for (const bad of ['<script', '<iframe', '<form', '<style', 'onerror', 'onclick', 'onload', 'javascript:', 'srcdoc']) expect([entry.id, bad, markdown.includes(bad)]).toEqual([entry.id, bad, false]);
      } finally {
        await opened.stop();
      }
    });
  }

  test('a paste with a script, a frame, an onclick, a style and a javascript: link gives a document of text and safe links, as Markdown', async ({ page }) => {
    const opened = await open(page);
    try {
      await paste(
        page,
        '<p>Hello <strong>bold</strong> world.</p><script>window.__pwned = 1</script><iframe src="https://evil.example/"></iframe>' +
          '<p onclick="window.__pwned = 2" style="background:url(https://evil.example/t.gif)">Click <a href="javascript:window.__pwned=3">here</a> or <a href="https://a.test/ok">there</a>.</p>' +
          '<style>p { display: none }</style>',
      );
      await expect.poll(() => opened.markdown()).toContain('Hello **bold** world.');
      expect((await opened.markdown()).trim()).toBe('Start.\n\nHello **bold** world.\n\nClick here or [there](https://a.test/ok).');
      expect(opened.dialogs).toEqual([]);
      expect(opened.offOrigin()).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  test('what a page is made of survives the paste: headings, lists, quotes, code with its language, tables, emphasis and safe links', async ({ page }) => {
    const opened = await open(page);
    try {
      await paste(
        page,
        '<h2>Plan</h2><ul><li>one</li><li>two</li></ul><blockquote>quoted</blockquote><pre data-language="js"><code>let x = 1;</code></pre>' +
          '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p><em>soft</em> and <a href="/p/x">relative</a>.</p>',
      );
      await expect.poll(() => opened.markdown()).toContain('## Plan');
      const markdown = await opened.markdown();
      const missing = ['* one', '* two', '> quoted', '```js', 'let x = 1;', '| a  | b  |', '| 1  | 2  |', '*soft*', '[relative](/p/x)'].filter((part) => !markdown.includes(part));
      expect(missing, markdown).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  test('the sanitiser by itself keeps no class and no data attribute but a code language, drops an image source the image rule refuses, and is the same on a second pass', async ({ page }) => {
    const opened = await open(page);
    try {
      const out = await page.evaluate(() => {
        const sanitize = (window as unknown as { harness: { sanitize: (h: string) => string } }).harness.sanitize;
        const once = sanitize(
          '<p class="page-editor" data-x="1" aria-label="x" id="y">t</p><pre data-language="ts evil"><code class="language-ts">c</code></pre><pre data-language="ts">d</pre><img src="data:image/png;base64,AAAA"><img src="https://a.test/i.png" alt="i">',
        );
        return { once, twice: sanitize(once) };
      });
      expect(out.once).toBe('<p>t</p><pre><code>c</code></pre><pre data-language="ts">d</pre><img><img src="https://a.test/i.png" alt="i">');
      expect(out.twice).toBe(out.once);
    } finally {
      await opened.stop();
    }
  });
});
