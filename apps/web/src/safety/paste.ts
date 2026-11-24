import { editorViewOptionsCtx } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { isSafeUrl } from '@tektum/grimoire-editor-schema';
import DOMPurify from 'dompurify';
import { isSafeHref } from './index';

/**
 * What a paste may bring in (contracts section 8, rule 3): the structural and inline text elements of a page, links, images, tables, lists and code. No script, frame, form,
 * style, object, embed, svg or math element, no event handler, no `style` attribute, no `data-` (but the language of a code block) or `aria-` attribute, no class, and an address only if the rule for it lets it be one.
 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small',
  'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'data-language'];
/** The one `data-` attribute a paste keeps: the language of a code block (`<pre data-language="js">`), which is where the schema reads it from. */
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,40}$/;

const purify = DOMPurify(window);
purify.addHook('uponSanitizeAttribute', (node, data) => {
  const name = data.attrName;
  if (name === 'href' && !isSafeHref(data.attrValue)) data.keepAttr = false;
  else if (name === 'src' && !isSafeUrl(data.attrValue, 'image')) data.keepAttr = false;
  else if (name === 'data-language' && !(node.nodeName === 'PRE' && LANGUAGE.test(data.attrValue))) data.keepAttr = false;
});

/** The HTML of a paste or a drop, with everything outside the allow-list taken out (an element goes, its words stay; an attribute that is not allowed goes). */
export function sanitizePastedHtml(html: string): string {
  return purify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM: false, RETURN_DOM_FRAGMENT: false });
}

/**
 * Puts the sanitising in front of the editor's reading of pasted HTML. Whatever other plugin also transforms it (the clipboard's own clean-up of word-processor markup) sees
 * the sanitised text, whichever of them was added first.
 */
export const pasteSanitizer: MilkdownPlugin = (ctx) => async () => {
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    transformPastedHTML: (html, view) => {
      const clean = sanitizePastedHtml(html);
      return prev.transformPastedHTML === undefined ? clean : prev.transformPastedHTML(clean, view);
    },
  }));
};
