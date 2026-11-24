import type { Page } from '@playwright/test';

/** What a browser's clipboard carries into a paste: files (made of `bytes` bytes, or of the bytes of `base64`), HTML, and text. */
export interface PasteData {
  readonly files?: readonly { name: string; type: string; bytes?: number; base64?: string }[];
  readonly html?: string;
  readonly text?: string;
  /** The text of the HTML as `text/plain`, as the browser makes it (read in the page, which has a parser), instead of `text`. */
  readonly textOfHtml?: true;
}

/** What a listener of the page saw in the event: the number of files, and the types. */
export interface PasteSeen {
  readonly files: number;
  readonly types: readonly string[];
}

/**
 * Pastes `data` into the editor of the page, as a browser's clipboard carries it: ONE helper for every specification, because the engines disagree about an event made by a script.
 * Firefox gives such an event an empty clipboard whatever it is made with (`new ClipboardEvent('paste', { clipboardData })` has no files and no types there, and a check made
 * through it passes with nothing pasted), so the data goes on the event as a property, which every engine reads the same way. A listener that stands before the editor's reads the
 * event as the editor does, and the helper fails, with a plain line, when what it saw is not what was put in: a paste that carried nothing is not a pass.
 */
export async function pasteIntoEditor(page: Page, data: PasteData): Promise<PasteSeen> {
  const seen = await page.evaluate((input) => {
    const clipboard = new DataTransfer();
    for (const file of input.files ?? []) {
      const bytes = file.base64 === undefined ? new Uint8Array(file.bytes ?? 3) : Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      clipboard.items.add(new File([bytes], file.name, { type: file.type }));
    }
    if (input.html !== undefined) clipboard.setData('text/html', input.html);
    if (input.text !== undefined) clipboard.setData('text/plain', input.text);
    if (input.textOfHtml === true && input.html !== undefined) clipboard.setData('text/plain', new DOMParser().parseFromString(input.html, 'text/html').body.textContent ?? '');
    let saw: { files: number; types: string[] } = { files: -1, types: [] };
    document.addEventListener('paste', (e) => (saw = { files: (e as ClipboardEvent).clipboardData?.files.length ?? -1, types: Array.from((e as ClipboardEvent).clipboardData?.types ?? []) }), {
      capture: true,
      once: true,
    });
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboard });
    document.querySelector('.ProseMirror')!.dispatchEvent(event);
    return saw;
  }, data);
  const wantFiles = data.files?.length ?? 0;
  const wantTypes = [...(data.html === undefined || data.html === '' ? [] : ['text/html']), ...((data.text === undefined || data.text === '') && data.textOfHtml !== true ? [] : ['text/plain'])]; // an empty value puts no type in
  if (seen.files !== wantFiles || wantTypes.some((t) => !seen.types.includes(t))) {
    throw new Error(`the paste carried no data in this engine: the page saw ${seen.files} file(s) and the types [${seen.types.join(', ')}], where ${wantFiles} file(s) and [${wantTypes.join(', ')}] were put in`);
  }
  return seen;
}

/**
 * Drops `data` (HTML and text) on the editor at a point of the page, as a browser's drag carries it: the same helper idea as the paste (a drag event made by a script has an empty
 * `dataTransfer` in Firefox, so the data goes on the event as a property), and the same failure when the page saw nothing.
 */
export async function dropOnEditor(page: Page, data: { html?: string; text?: string }, point: { x: number; y: number }): Promise<void> {
  const seen = await page.evaluate(
    ({ input, at }) => {
      const transfer = new DataTransfer();
      if (input.html !== undefined) transfer.setData('text/html', input.html);
      if (input.text !== undefined) transfer.setData('text/plain', input.text);
      let saw: string[] = [];
      document.addEventListener('drop', (e) => (saw = Array.from((e as DragEvent).dataTransfer?.types ?? [])), { capture: true, once: true });
      const event = new DragEvent('drop', { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      document.querySelector('.ProseMirror')!.dispatchEvent(event);
      return saw;
    },
    { input: data, at: point },
  );
  const wantTypes = [...(data.html === undefined || data.html === '' ? [] : ['text/html']), ...(data.text === undefined || data.text === '' ? [] : ['text/plain'])];
  if (wantTypes.some((t) => !seen.includes(t))) throw new Error(`the drop carried no data in this engine: the page saw the types [${seen.join(', ')}], where [${wantTypes.join(', ')}] were put in`);
}
