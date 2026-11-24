import { editorViewCtx } from '@milkdown/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideAttachments } from '../../src/editor/attachments/host';
import { chooseFiles } from '../../src/editor/attachments/pick';
import { attachmentPlugins } from '../../src/editor/attachments/plugin';
import { makeEditor, type Harness } from '../tables/support';

const ID = '00000000-0000-4000-8000-000000000001';

/** Notes the file input the code creates (it is never put in the page) and keeps it from opening a real chooser. */
function captureChooser(): { input: () => HTMLInputElement | undefined } {
  let found: HTMLInputElement | undefined;
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const element = create(tag);
    if (tag === 'input') found = element as HTMLInputElement;
    return element;
  }) as never);
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
  return { input: () => found };
}

describe('choosing files from the menu', () => {
  let harness: Harness;
  let dispose: () => void;
  const notify = vi.fn();
  beforeEach(async () => {
    notify.mockClear();
    harness = await makeEditor('first\n\nsecond\n', attachmentPlugins);
    dispose = provideAttachments(harness.root, {
      fetchUrls: async () => new Map(),
      pageId: '99999999-8888-4777-8666-555555555555',
      notify,
      put: (async () => new Response(null, { status: 200 })) as never,
      uploadApi: {
        POST: async (path: string) =>
          path === '/v1/attachments'
            ? { data: { id: ID, markdownPath: `attachments/${ID}/a.png`, upload: { url: 'https://files.test/put', headers: {} } }, response: new Response('{}', { status: 201 }) }
            : { data: { id: ID, fileName: 'a.png', contentType: 'image/png', size: 1, markdownPath: `attachments/${ID}/a.png`, pageId: 'p' }, response: new Response('{}', { status: 200 }) },
      } as never,
    });
  });
  afterEach(async () => { dispose(); vi.restoreAllMocks(); await harness.destroy(); });

  it('opens the file chooser (images and any file, several at once) and uploads what is chosen into the page at the cursor', async () => {
    const captured = captureChooser();
    harness.cursorAtStart();
    const done = harness.editor.action((ctx) => chooseFiles(ctx));
    expect(captured.input()?.type).toBe('file');
    expect(captured.input()?.multiple).toBe(true);
    Object.defineProperty(captured.input(), 'files', { value: [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })] });
    captured.input()!.dispatchEvent(new Event('change'));
    await done;
    expect(harness.markdown()).toContain(`![a.png](attachments/${ID}/a.png)`);
  });

  it('does nothing when the chooser is closed without a file', async () => {
    const captured = captureChooser();
    const before = harness.markdown();
    const done = harness.editor.action((ctx) => chooseFiles(ctx));
    Object.defineProperty(captured.input(), 'files', { value: [] });
    captured.input()!.dispatchEvent(new Event('change'));
    await done;
    expect(harness.markdown()).toBe(before);
    expect(harness.editor.action((ctx) => ctx.get(editorViewCtx).state.doc.childCount)).toBe(2);
  });
});
