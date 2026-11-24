import { expect, test, type Page } from '@playwright/test';
import { isSafeHref } from '../../src/safety';
import { type XssEntry, xssCorpus } from '../../test/corpus/xss';
import { bundleHarness } from '../collections/bundle';
import { fixtureServer } from '../support/fixtures';

// The one corpus of hostile input (test/corpus/xss.ts) through the three ways text gets into a page: Markdown read into the editor (an import, a restore, a saved page),
// HTML or text pasted, and Markdown applied to the editor that is open. Whatever the way, nothing runs, nothing is fetched from elsewhere, and what is drawn is text and
// links that pass the rule for links.
const FORBIDDEN_TAGS = ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'style', 'link', 'meta', 'base', 'svg', 'math', 'template'];

/** The Markdown the entry stands for: its own, or (an entry of pasted HTML) the HTML as a line of raw HTML in a page. */
const asMarkdown = (entry: XssEntry): string => entry.markdown ?? entry.html ?? '';

async function open(page: Page) {
  const bundle = await bundleHarness('../safety/paste-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>Grimoire</title><div id="host"></div>' });
  const dialogs: string[] = [];
  const requests: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(server.url('/'));
  await page.addStyleTag({ content: bundle.css });
  await page.addScriptTag({ content: bundle.js });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  const offOrigin = (): string[] => requests.filter((u) => !u.startsWith(server.url('/')) && !u.startsWith('data:') && !u.startsWith('blob:'));
  return { dialogs, requests, offOrigin, stop: () => server.stop() };
}

/**
 * What an element made by an entry would have done is done when this returns: the browser asks for an image the moment the element is made, which is before the next
 * frame, so two frames later the request has been made; an image that is still loading is waited for. (A fixed sleep would only hope.)
 */
const settled = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    await Promise.all([...document.images].map((img) => (img.complete ? undefined : new Promise((resolve) => { img.addEventListener('load', resolve); img.addEventListener('error', resolve); }))));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

type Harness = { mount: (markdown: string, editable: boolean) => Promise<void>; apply: (markdown: string) => void };

/** What is wrong with the page after an entry went through it (empty when nothing is). */
async function problems(page: Page, id: string, dialogs: string[], offOrigin: () => string[], before: number): Promise<string[]> {
  const found = await page.evaluate((forbidden) => {
    const surface = document.querySelector('.ProseMirror');
    const elements = surface === null ? [] : [...surface.querySelectorAll('*')];
    return {
      tags: elements.map((e) => e.tagName.toLowerCase()).filter((t) => forbidden.includes(t)),
      attributes: elements.flatMap((e) => e.getAttributeNames().filter((a) => /^on/i.test(a) || a === 'style' || a === 'srcdoc' || a === 'formaction').map((a) => `${e.tagName.toLowerCase()}[${a}]`)),
      links: surface === null ? [] : [...surface.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? ''),
      pwned: (window as unknown as { __pwned?: unknown }).__pwned !== undefined,
    };
  }, FORBIDDEN_TAGS);
  const wrong: string[] = [];
  for (const tag of found.tags) wrong.push(`${id}: a ${tag} element`);
  for (const attribute of found.attributes) wrong.push(`${id}: ${attribute}`);
  for (const href of found.links) if (!isSafeHref(href)) wrong.push(`${id}: a link to ${JSON.stringify(href)}`);
  if (found.pwned) wrong.push(`${id}: a script ran`);
  if (dialogs.length > 0) wrong.push(`${id}: a dialog opened: ${dialogs.join(' | ')}`);
  const left = offOrigin();
  if (left.length > before) wrong.push(`${id}: a request left the page: ${left.slice(before).join(' | ')}`);
  return wrong;
}

test.describe('the corpus of hostile input', () => {
  const entries = xssCorpus.filter((entry) => entry.expect !== 'bounded');
  const bounded = xssCorpus.filter((entry) => entry.expect === 'bounded');

  test('read into the editor as Markdown (an import, a restore, a saved page), every entry draws only text and safe links', async ({ page }) => {
    const opened = await open(page);
    try {
      const wrong: string[] = [];
      for (const entry of entries) {
        const before = opened.offOrigin().length;
        await page.evaluate(([markdown]) => (window as unknown as { harness: Harness }).harness.mount(markdown!, false), [asMarkdown(entry)]);
        await settled(page);
        wrong.push(...(await problems(page, entry.id, opened.dialogs, opened.offOrigin, before)));
      }
      expect(wrong).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  test('applied to the editor that is open, every entry draws only text and safe links', async ({ page }) => {
    const opened = await open(page);
    try {
      const wrong: string[] = [];
      for (const entry of entries) {
        const before = opened.offOrigin().length;
        await page.evaluate(([markdown]) => {
          const harness = (window as unknown as { harness: Harness }).harness;
          return harness.mount('Start.\n', true).then(() => harness.apply(markdown!));
        }, [asMarkdown(entry)]);
        await settled(page);
        wrong.push(...(await problems(page, entry.id, opened.dialogs, opened.offOrigin, before)));
      }
      expect(wrong).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  test('pasted (HTML as HTML, Markdown and addresses as the text and the link a person would copy), every entry draws only text and safe links', async ({ page }) => {
    const opened = await open(page);
    try {
      const wrong: string[] = [];
      for (const entry of entries) {
        const before = opened.offOrigin().length;
        const html = entry.html ?? (entry.href === undefined ? undefined : `<a href="${entry.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">link</a>`);
        await page.evaluate(([markdown]) => (window as unknown as { harness: Harness }).harness.mount(markdown!, true), ['Start.\n']);
        await page.locator('.ProseMirror').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.press('Enter');
        await page.evaluate(
          ([pastedHtml, text]) => {
            const data = new DataTransfer();
            if (pastedHtml !== undefined && pastedHtml !== null) data.setData('text/html', pastedHtml);
            data.setData('text/plain', text!);
            document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
          },
          [html ?? null, entry.markdown ?? entry.html ?? entry.href ?? ''],
        );
        await settled(page);
        wrong.push(...(await problems(page, entry.id, opened.dialogs, opened.offOrigin, before)));
      }
      expect(wrong).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  test('dropped on the page (HTML as HTML, everything else as the text it is), every entry draws only text and safe links, and a dropped Markdown image is text, not a request', async ({ page }) => {
    const opened = await open(page);
    try {
      const wrong: string[] = [];
      for (const entry of entries) {
        const before = opened.offOrigin().length;
        await page.evaluate(([markdown]) => (window as unknown as { harness: Harness }).harness.mount(markdown!, true), ['Start.\n']);
        const box = (await page.locator('.ProseMirror p').first().boundingBox())!;
        await page.evaluate(
          ([html, text, x, y]) => {
            const data = new DataTransfer();
            if (html !== null) data.setData('text/html', html as string);
            data.setData('text/plain', text as string);
            document.querySelector('.ProseMirror')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: x as number, clientY: y as number, bubbles: true, cancelable: true }));
          },
          [entry.html ?? null, entry.markdown ?? entry.html ?? entry.href ?? '', box.x + 5, box.y + box.height / 2],
        );
        await settled(page);
        wrong.push(...(await problems(page, entry.id, opened.dialogs, opened.offOrigin, before)));
      }
      expect(wrong).toEqual([]);
      // And the drop does land: a dropped Markdown image is the text it was typed as (the editor reads a dropped text as text), with no image made from it.
      await page.evaluate(([markdown]) => (window as unknown as { harness: Harness }).harness.mount(markdown!, true), ['Start.\n']);
      const box = (await page.locator('.ProseMirror p').first().boundingBox())!;
      await page.evaluate(([x, y]) => {
        const data = new DataTransfer();
        data.setData('text/plain', '![](https://evil.example/x.png)');
        document.querySelector('.ProseMirror')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: x!, clientY: y!, bubbles: true, cancelable: true }));
      }, [box.x + 5, box.y + box.height / 2]);
      await settled(page);
      await expect(page.locator('.ProseMirror')).toContainText('https://evil.example/x.png');
      await expect(page.locator('.ProseMirror .attachment-image')).toHaveCount(0);
      expect(opened.offOrigin()).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  for (const entry of bounded) {
    test(`${entry.id}: large and deeply nested input is taken in, in time, and the page still answers`, async ({ page }) => {
      test.setTimeout(120_000);
      const opened = await open(page);
      try {
        const started = Date.now();
        await page.evaluate(([markdown]) => (window as unknown as { harness: Harness }).harness.mount(markdown!, false), [asMarkdown(entry)]);
        expect(Date.now() - started, 'taken in within a minute').toBeLessThan(60_000);
        expect(await page.evaluate(() => 1 + 1)).toBe(2); // the page's thread is free
        expect(opened.dialogs).toEqual([]);
        expect(opened.offOrigin()).toEqual([]);
      } finally {
        await opened.stop();
      }
    });
  }
});
