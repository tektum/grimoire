import { uploadConfig } from '@milkdown/plugin-upload';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { storeFetch } from '../../src/api/store';
import type { Session } from '../../src/auth/session';
import { quietApiOf } from '../../src/editor/attachments/quiet-api';
import { attachmentPlugins } from '../../src/editor/attachments/plugin';
import { SLASH_KINDS } from '../../src/editor/menus/blocks';
import { makeEditor } from '../tables/support';

afterEach(() => vi.restoreAllMocks());

describe('the file store request', () => {
  it('is a plain fetch of the address it is given: the caller sets the method, the headers and no credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const init = { method: 'PUT', headers: { 'content-type': 'image/png' }, credentials: 'omit' } as const;
    await storeFetch('https://files.test/put', init);
    expect(fetchMock).toHaveBeenCalledWith('https://files.test/put', init);
  });
});

describe('the quiet API client of the upload', () => {
  const session = (apiUrl?: string): Session => ({ auth: { getToken: async () => 'tok', refresh: async () => false, signOut: async () => undefined }, api: {}, collabUrl: 'ws://x', ...(apiUrl === undefined ? {} : { apiUrl }) }) as unknown as Session;

  it('is absent when the session has no API address', () => {
    expect(quietApiOf(session())).toBeUndefined();
  });

  it('sends the session token and the client version, and a refusal makes no toast of its own', async () => {
    const seen: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(input as Request);
      return new Response(JSON.stringify({ error: { code: 'type_not_allowed', message: 'no' } }), { status: 422, headers: { 'content-type': 'application/json' } });
    });
    const api = quietApiOf(session('http://api.test'))!;
    const result = await api.POST('/v1/attachments' as never, { body: { pageId: 'p', fileName: 'a.exe', contentType: 'application/x-msdownload', size: 1 } } as never);
    expect(result.response.status).toBe(422);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(seen[0]!.headers.get('x-grimoire-client-version')).not.toBeNull();
    expect(document.body.textContent).not.toContain("That file type isn't allowed"); // told once, by the upload
  });
});

describe('the upload marker and the menu item', () => {
  it('marks the place of an upload in progress for assistive technology, and says so in words', async () => {
    const harness = await makeEditor('text\n', attachmentPlugins);
    const decoration = harness.editor.action((ctx) => ctx.get(uploadConfig.key).uploadWidgetFactory(1, { id: 'x' }));
    const dom = (decoration as unknown as { type: { toDOM: HTMLElement } }).type.toDOM;
    expect(dom.textContent).toBe('Uploading…');
    expect(dom.getAttribute('aria-busy')).toBe('true');
    expect(dom.className).toBe('attachment-uploading');
    await harness.destroy();
  });

  it('"Image or file" opens the chooser and says it did the thing', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    const harness = await makeEditor('text\n', attachmentPlugins);
    const kind = SLASH_KINDS.find((k) => k.id === 'file')!;
    expect(harness.editor.action((ctx) => kind.run(ctx))).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    await harness.destroy();
  });
});
