import { editorViewOptionsCtx, parserCtx } from '@milkdown/core';
import type { MilkdownPlugin } from '@milkdown/ctx';
import { isSafeUrl } from '@tektum/grimoire-editor-schema';
import { Slice } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { $prose } from '@milkdown/utils';
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

/**
 * Markdown pasted as text (no HTML on the clipboard) is read into nodes and put into the document as they are. The clipboard plugin reads it by writing the nodes out as DOM
 * with the schema's own `toDOM` and reading that back: an image node is then an `img` element with its source set, which the browser starts to load at once, before the
 * image is anywhere in the page, so `![](https://elsewhere.example/pixel.png)` pasted as text told that host. This takes the text before the clipboard plugin (it must be
 * added to the editor ahead of it); a paste with HTML, from a code editor, into a code block, or into a page that cannot be edited is left to the clipboard plugin.
 */
export const pastedMarkdownKey = new PluginKey('grimoire-pasted-markdown');

export const pastedMarkdown: MilkdownPlugin[] = [
  $prose((ctx) =>
    new Plugin({
      key: pastedMarkdownKey,
      props: {
        handlePaste: (view, event) => {
          const data = event.clipboardData;
          if (data === null || view.props.editable?.(view.state) !== true || view.state.selection.$from.node().type.spec.code) return false;
          const text = data.getData('text/plain');
          if (text === '' || data.getData('text/html') !== '' || data.getData('vscode-editor-data') !== '') return false;
          const parsed = ctx.get(parserCtx)(text); // read when it is needed: the parser is not made yet when the plugin is
          if (typeof parsed === 'string' || !parsed) return false; // what the parser gives is a document; its content, opened at both ends, is what a paste of text is
          view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(parsed.content)).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
          event.preventDefault();
          return true;
        },
      },
    }),
  ),
].flat();
