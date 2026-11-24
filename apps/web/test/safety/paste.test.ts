import { editorViewOptionsCtx } from '@milkdown/core';
import { clipboard } from '@milkdown/plugin-clipboard';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEditor } from '../tables/support';

// DOMPurify does not work in the test DOM of this project (happy-dom keeps what it should remove), so what it does to HTML is checked in a real browser
// (test-e2e/safety/paste.spec.ts). Here DOMPurify is stood in for, to check what this module tells it: the allow-list, the rule for each address and class, and how the
// sanitising is put in front of the editor's reading of a paste.
const captured = vi.hoisted(() => ({
  hooks: [] as { name: string; run: (node: { nodeName: string }, data: { attrName: string; attrValue: string; keepAttr: boolean }) => void }[],
  calls: [] as { html: string; config: Record<string, unknown> }[],
}));
vi.mock('dompurify', () => ({
  default: () => ({
    addHook: (name: string, run: never) => captured.hooks.push({ name, run }),
    sanitize: (html: string, config: Record<string, unknown>) => {
      captured.calls.push({ html, config });
      return `CLEAN(${html})`;
    },
  }),
}));

const { pasteSanitizer, sanitizePastedHtml } = await import('../../src/safety/paste');

const decide = (node: string, attrName: string, attrValue: string): boolean => {
  const data = { attrName, attrValue, keepAttr: true };
  for (const hook of captured.hooks) if (hook.name === 'uponSanitizeAttribute') hook.run({ nodeName: node }, data);
  return data.keepAttr;
};

describe('what the paste sanitiser tells DOMPurify', () => {
  beforeEach(() => { captured.calls.length = 0; });

  it('allows the elements of a page and none that is active, and the few attributes a page needs', () => {
    sanitizePastedHtml('<p>x</p>');
    const config = captured.calls[0]!.config as { ALLOWED_TAGS: string[]; ALLOWED_ATTR: string[]; ALLOW_DATA_ATTR: boolean; ALLOW_ARIA_ATTR: boolean };
    for (const tag of ['p', 'br', 'h1', 'h6', 'blockquote', 'pre', 'code', 'em', 'strong', 'ul', 'ol', 'li', 'a', 'img', 'table', 'tr', 'td', 'th', 'hr']) expect(config.ALLOWED_TAGS).toContain(tag);
    for (const tag of ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'style', 'link', 'meta', 'base', 'svg', 'math', 'template', 'video', 'audio', 'source', 'details', 'textarea', 'select'])
      expect([tag, config.ALLOWED_TAGS.includes(tag)]).toEqual([tag, false]);
    expect(config.ALLOWED_ATTR).toEqual(expect.arrayContaining(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'data-language']));
    expect(config.ALLOWED_ATTR).not.toContain('class');
    for (const attribute of config.ALLOWED_ATTR) expect([attribute, /^on/i.test(attribute) || ['style', 'srcdoc', 'formaction', 'action', 'xlink:href', 'target'].includes(attribute)]).toEqual([attribute, false]);
    expect(config.ALLOW_DATA_ATTR).toBe(false);
    expect(config.ALLOW_ARIA_ATTR).toBe(false);
  });

  it('hands DOMPurify the text as it was and returns what it returns', () => {
    expect(sanitizePastedHtml('<p>hello</p>')).toBe('CLEAN(<p>hello</p>)');
  });

  it.each([
    ['https://a.test/x', true],
    ['http://a.test', true],
    ['mailto:a@b.test', true],
    ['/p/x', true],
    ['./x', true],
    ['#a', true],
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['java\tscript:alert(1)', false],
    ['data:text/html,<script>', false],
    ['vbscript:x', false],
    ['file:///etc/passwd', false],
  ])('a link to %j is kept: %s', (href, kept) => {
    expect(decide('A', 'href', href)).toBe(kept);
  });

  it.each([
    ['https://a.test/i.png', true],
    ['attachments/3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b/a.png', true],
    ['./x.png', true],
    ['data:image/png;base64,AAAA', false],
    ['javascript:alert(1)', false],
  ])('an image from %j is kept: %s', (src, kept) => {
    expect(decide('IMG', 'src', src)).toBe(kept);
  });

  it.each([
    ['PRE', 'js', true],
    ['PRE', 'c++', true],
    ['PRE', 'objective-c', true],
    ['PRE', 'js evil', false],
    ['PRE', '"><script>', false],
    ['PRE', '', false],
    ['PRE', 'x'.repeat(41), false],
    ['CODE', 'js', false],
    ['P', 'js', false],
  ])('the language of a %s, %j, is kept: %s', (node, value, kept) => {
    expect(decide(node, 'data-language', value)).toBe(kept);
  });

  it('leaves the other allowed attributes to DOMPurify', () => {
    for (const name of ['alt', 'title', 'colspan', 'rowspan']) expect(decide('IMG', name, 'x')).toBe(true);
  });
});

describe('the sanitising in front of the editor', () => {
  const transformOf = async (plugins: Parameters<typeof makeEditor>[1]) => {
    const harness = await makeEditor('', plugins);
    const options = harness.editor.action((ctx) => ctx.get(editorViewOptionsCtx));
    return { harness, transform: options.transformPastedHTML! };
  };

  it('is the first to see the HTML when it was added after the clipboard plugin', async () => {
    const { harness, transform } = await transformOf([clipboard, pasteSanitizer].flat());
    expect(transform('<p>x</p>', harness.view)).toBe('CLEAN(<p>x</p>)');
    await harness.destroy();
  });

  it('is the first to see the HTML when it was added before the clipboard plugin, which then cleans what is left', async () => {
    const { harness, transform } = await transformOf([pasteSanitizer, clipboard].flat());
    expect(transform('<b id="docs-internal-guid-1"><p>x</p></b>', harness.view)).toContain('CLEAN(');
    expect(captured.calls.at(-1)!.html).toBe('<b id="docs-internal-guid-1"><p>x</p></b>'); // what DOMPurify got is the paste as it came
    await harness.destroy();
  });

  it('works with no other transform of pasted HTML', async () => {
    const { harness, transform } = await transformOf(pasteSanitizer);
    expect(transform('<p>y</p>', harness.view)).toBe('CLEAN(<p>y</p>)');
    await harness.destroy();
  });
});
