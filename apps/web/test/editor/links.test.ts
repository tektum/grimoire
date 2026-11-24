import { afterEach, describe, expect, it } from 'vitest';
import { guardLinks } from '../../src/editor/core/links';
import { isSafeHref } from '../../src/safety';

const root = document.createElement('div');
document.body.append(root);
afterEach(() => (root.innerHTML = ''));

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const hrefs = (): (string | null)[] => [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));

const UNSAFE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://x/y',
  'javascript&colon;alert(1)',
  '\u200bjavascript:alert(1)',
  '%6Aavascript:alert(1)',
];
const SAFE = ['https://example.com/a?b=c#d', 'http://example.com', 'mailto:ada@example.com', '/p/plan-ab12cd', '#section', 'relative/path', '//example.com/x', 'tel:+15550100', 'ftp://example.com/file'];

describe('links in the editor go through the one allow-list', () => {
  it('takes the href from every link the allow-list refuses, whatever the spelling, and marks it', async () => {
    root.innerHTML = UNSAFE.map((href) => `<a href="${href.replaceAll('"', '&quot;')}">link</a>`).join('');
    const stop = guardLinks(root);
    // sanity: the allow-list refuses all of these, so the test checks the guard, not the list
    for (const href of [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))) expect(isSafeHref(href)).toBe(false);
    stop();
    root.innerHTML = UNSAFE.map((href) => `<a href="${href.replaceAll('"', '&quot;')}">link</a>`).join('');
    const guard = guardLinks(root);
    expect(hrefs().every((h) => h === null)).toBe(true);
    expect([...root.querySelectorAll('a')].every((a) => a.getAttribute('data-unsafe-link') === 'true')).toBe(true);
    guard();
  });

  it('keeps every link the allow-list accepts (web, mail, relative, and the hand-over schemes it names, tel and ftp among them)', () => {
    root.innerHTML = SAFE.map((href) => `<a href="${href}">link</a>`).join('');
    const stop = guardLinks(root);
    expect(hrefs()).toEqual(SAFE);
    expect(root.querySelector('[data-unsafe-link]')).toBeNull();
    stop();
  });

  it("guards links that arrive later: another person's edit, or a re-render, inserts one", async () => {
    const stop = guardLinks(root);
    root.innerHTML = '<p>text <a href="javascript:alert(1)">bad</a> and <a href="https://example.com">good</a></p>';
    await settle();
    expect(hrefs()).toEqual([null, 'https://example.com']);
    const direct = document.createElement('a');
    direct.setAttribute('href', 'data:text/html,x');
    root.append(direct);
    await settle();
    expect(direct.hasAttribute('href')).toBe(false);
    stop();
  });

  it('guards a link whose address is changed to an unsafe one afterwards', async () => {
    root.innerHTML = '<a href="https://example.com">link</a>';
    const stop = guardLinks(root);
    root.querySelector('a')!.setAttribute('href', 'javascript:alert(1)');
    await settle();
    expect(root.querySelector('a')!.hasAttribute('href')).toBe(false);
    stop();
  });

  it('leaves an anchor with no address alone, and stops guarding when it is stopped', async () => {
    root.innerHTML = '<a name="x">anchor</a>';
    const stop = guardLinks(root);
    expect(root.querySelector('a')!.hasAttribute('data-unsafe-link')).toBe(false);
    stop();
    root.insertAdjacentHTML('beforeend', '<a href="javascript:alert(1)">late</a>');
    await settle();
    expect(root.querySelector('a[href^="javascript"]')).not.toBeNull(); // nothing watches any more
  });
});
