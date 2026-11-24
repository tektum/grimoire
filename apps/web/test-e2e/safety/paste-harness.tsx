import { mountReadOnly, type MountedEditor } from '../../src/editor/core/mount';
import { sanitizePastedHtml } from '../../src/safety/paste';
import '../../src/ui/global.css';
import '../../src/editor/core/lists.css';

/**
 * The real editor (the page's own plugins, the paste sanitising among them) made editable, with no API, no sign-in and no collaboration, and the sanitiser by itself.
 * `window.__ready` is set once the editor is mounted; `window.harness.markdown()` is the document as Markdown.
 */
let editor: MountedEditor | null = null;

/** Every string the page gives the browser's HTML parser through `innerHTML` (what the editor reads a paste with does), so a spec can see what the editor was handed. */
const parsed: string[] = [];
const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
if (descriptor?.set !== undefined) {
  Object.defineProperty(Element.prototype, 'innerHTML', {
    ...descriptor,
    set(value: string) {
      parsed.push(String(value));
      descriptor.set!.call(this, value);
    },
  });
}
(window as unknown as { harness: unknown }).harness = { markdown: (): string => editor?.markdown() ?? '', sanitize: sanitizePastedHtml, parsed: (): string[] => [...parsed], forget: (): void => void (parsed.length = 0) };
const host = document.getElementById('host');
if (host !== null) {
  const root = document.createElement('div');
  root.className = 'page-editor page-text';
  root.style.cssText = 'max-width: 42rem; margin: 3rem auto; padding: 0 1rem;';
  host.append(root);
  void mountReadOnly(root, 'Start.\n').then((mounted) => {
    editor = mounted;
    mounted.setEditable(true);
    (window as unknown as { __ready: boolean }).__ready = true;
  });
}
