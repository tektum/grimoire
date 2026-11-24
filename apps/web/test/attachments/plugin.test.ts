import { editorViewCtx } from '@milkdown/core';
import { uploadConfig } from '@milkdown/plugin-upload';
import type { Fragment } from '@milkdown/prose/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideAttachments, type AttachmentHost } from '../../src/editor/attachments/host';
import { attachmentPlugins, fragmentFor } from '../../src/editor/attachments/plugin';
import type { Attachment } from '../../src/editor/attachments/upload';
import { makeEditor, type Harness } from '../tables/support';

const ID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
const PAGE = '99999999-8888-4777-8666-555555555555';
const attachment = (name: string, type: string, id = ID): Attachment => ({ id, fileName: name, contentType: type, size: 3, markdownPath: `attachments/${id}/${encodeURIComponent(name)}`, pageId: PAGE });
const respond = (status: number, data?: unknown, error?: unknown) => ({ ...(data === undefined ? {} : { data }), ...(error === undefined ? {} : { error }), response: new Response('{}', { status }) });

describe('what an upload puts into the document', () => {
  let harness: Harness;
  beforeEach(async () => { harness = await makeEditor('text\n', attachmentPlugins); });
  afterEach(() => harness.destroy());
  const schema = () => harness.view.state.schema;

  it('is an image node for an image, with the saved path and the name as alt text', () => {
    const fragment = fragmentFor([attachment('photo.png', 'image/png')], schema());
    expect(fragment.childCount).toBe(1);
    expect(fragment.firstChild?.type.name).toBe('image');
    expect(fragment.firstChild?.attrs).toMatchObject({ src: `attachments/${ID}/photo.png`, alt: 'photo.png' });
  });

  it('is the file name as a link to the saved path for any other file', () => {
    const fragment = fragmentFor([attachment('plan v2.pdf', 'application/pdf')], schema());
    const node = fragment.firstChild!;
    expect(node.text).toBe('plan v2.pdf');
    expect(node.marks[0]?.type.name).toBe('link');
    expect(node.marks[0]?.attrs['href']).toBe(`attachments/${ID}/plan%20v2.pdf`);
  });

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])('shows %s inline, as an image node', (type) => {
    expect(fragmentFor([attachment('a', type)], schema()).firstChild?.type.name).toBe('image');
  });

  it.each(['image/bmp', 'image/tiff', 'image/svg+xml', 'application/pdf'])('makes %s a link: the server signs it as a download, so an img could never show it', (type) => {
    const node = fragmentFor([attachment('a', type)], schema()).firstChild!;
    expect(node.type.name).toBe('text');
    expect(node.marks[0]?.type.name).toBe('link');
  });

  it('puts a space between several files, and nothing for none', () => {
    const fragment = fragmentFor([attachment('a.png', 'image/png'), attachment('b.pdf', 'application/pdf', '11111111-2222-4333-8444-555555555555')], schema());
    expect(fragment.childCount).toBe(3);
    expect(fragment.child(1).text).toBe(' ');
    expect(fragmentFor([], schema()).childCount).toBe(0);
  });

  it('round-trips as Markdown: an image and a link keep the saved path, spaces and percent signs included', () => {
    const view = harness.view;
    const fragment = fragmentFor([attachment('100% plan.png', 'image/png'), attachment('a b.pdf', 'application/pdf', '11111111-2222-4333-8444-555555555555')], schema());
    view.dispatch(view.state.tr.insert(view.state.doc.content.size - 0, schema().nodes['paragraph']!.create(null, fragment)));
    const text = harness.markdown();
    expect(text).toContain(`![100% plan.png](attachments/${ID}/100%25%20plan.png)`);
    expect(text).toContain('[a b.pdf](attachments/11111111-2222-4333-8444-555555555555/a%20b.pdf)');
  });
});

describe('the uploader the editor is given', () => {
  let harness: Harness;
  let dispose: () => void;
  const notify = vi.fn();
  const fileList = (...files: File[]) => files as unknown as FileList;
  const uploadVia = async (files: File[]): Promise<Fragment> =>
    (await harness.editor.action((ctx) => ctx.get(uploadConfig.key).uploader(fileList(...files), ctx.get(editorViewCtx).state.schema, ctx, 1))) as Fragment;
  const host = (over: Partial<AttachmentHost> = {}): AttachmentHost => {
    let n = 0;
    return {
      fetchUrls: async () => new Map(),
      pageId: PAGE,
      notify,
      put: (async () => new Response(null, { status: 200 })) as never,
      uploadApi: {
        POST: async (path: string, init: { body?: { fileName: string; contentType: string } }) => {
          if (path === '/v1/attachments') {
            n += 1;
            const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
            return respond(201, { id, markdownPath: `attachments/${id}/${init.body!.fileName}`, upload: { url: 'https://files.test/put', headers: {}, method: 'PUT', expiresAt: 1 } });
          }
          const id = '00000000-0000-4000-8000-000000000001';
          return respond(200, attachment('x', 'image/png', id));
        },
      } as never,
      ...over,
    };
  };
  beforeEach(async () => {
    notify.mockClear();
    harness = await makeEditor('text\n', attachmentPlugins);
    dispose = provideAttachments(harness.root, host());
  });
  afterEach(async () => { dispose(); await harness.destroy(); });

  it('uploads each file and returns the nodes for those that were stored', async () => {
    const fragment = await uploadVia([new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })]);
    expect(fragment.childCount).toBe(1);
    expect(fragment.firstChild?.type.name).toBe('image');
    expect(notify).not.toHaveBeenCalled();
  });

  it('tells each distinct refusal once, and leaves nothing in the document for a refused file', async () => {
    dispose();
    dispose = provideAttachments(harness.root, host({ uploadApi: { POST: async () => respond(422, undefined, { error: { code: 'type_not_allowed' } }) } as never }));
    const fragment = await uploadVia([new File([new Uint8Array([1])], 'a.exe'), new File([new Uint8Array([1])], 'b.exe')]);
    expect(fragment.childCount).toBe(0);
    expect(notify.mock.calls).toEqual([["That file type isn't allowed"]]);
  });

  it('keeps the files that were stored when another is refused', async () => {
    let call = 0;
    dispose();
    dispose = provideAttachments(harness.root, host({
      uploadApi: {
        POST: async (path: string) => {
          if (path === '/v1/attachments') {
            call += 1;
            return call === 2 ? respond(429, undefined, { error: { code: 'rate_limited' } }) : respond(201, { id: `00000000-0000-4000-8000-00000000000${call}`, markdownPath: 'x', upload: { url: 'https://files.test/put', headers: {} } });
          }
          return respond(200, attachment('ok.png', 'image/png', '00000000-0000-4000-8000-000000000001'));
        },
      } as never,
    }));
    const fragment = await uploadVia([new File([new Uint8Array([1])], '1.png', { type: 'image/png' }), new File([new Uint8Array([1])], '2.png', { type: 'image/png' })]);
    expect(fragment.childCount).toBe(1);
    expect(notify.mock.calls).toEqual([['Too many uploads at once. Wait a moment.']]);
  });

  it('with no upload host (an editor with no page) says so and inserts nothing', async () => {
    dispose();
    dispose = provideAttachments(harness.root, { fetchUrls: async () => new Map() });
    expect((await uploadVia([new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })])).childCount).toBe(0);
  });
});

describe('opening an attachment link', () => {
  let harness: Harness;
  let dispose: () => void;
  const open = vi.fn();
  const told = vi.fn();
  const GET = vi.fn<(path: string, init?: unknown) => Promise<never>>(async () => ({ data: { url: 'https://files.test/signed?download', expiresAt: 5 }, response: new Response('{}', { status: 200 }) }) as never);
  beforeEach(async () => {
    open.mockClear();
    told.mockClear();
    GET.mockClear();
    harness = await makeEditor(`[the plan](attachments/${ID}/plan.pdf) and [a site](https://example.test/x)\n`, attachmentPlugins, { editable: false });
    dispose = provideAttachments(harness.root, { fetchUrls: async () => new Map(), api: { GET } as never, open, notify: told });
  });
  afterEach(async () => { dispose(); await harness.destroy(); });
  const click = (link: Element): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    return event;
  };

  it('asks for a signed link at the moment of the click and opens that, never the header-less path', async () => {
    const link = harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!;
    expect(GET).not.toHaveBeenCalled();
    const event = click(link);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://files.test/signed?download'));
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith('/v1/attachments/{id}', { params: { path: { id: ID }, query: { download: true } } });
  });

  describe('with no opener of the host (the real browser path)', () => {
    const fakeTab = () => ({ opener: 'x' as unknown, location: { replace: vi.fn() }, close: vi.fn() });
    beforeEach(() => {
      dispose();
      dispose = provideAttachments(harness.root, { fetchUrls: async () => new Map(), api: { GET } as never, notify: told });
    });

    it('opens the new tab in the click itself, before the answer comes, then sends it to the signed link', async () => {
      const tab = fakeTab();
      const opener = vi.spyOn(window, 'open').mockReturnValue(tab as never);
      let answer: (v: never) => void = () => undefined;
      GET.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
      click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
      expect(opener).toHaveBeenCalledTimes(1); // synchronous with the click: a pop-up blocker allows it
      expect(tab.opener).toBeNull(); // the page that opened it cannot be reached from it
      answer({ data: { url: 'https://files.test/signed?download' }, response: new Response('{}', { status: 200 }) } as never);
      await vi.waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('https://files.test/signed?download'));
      expect(tab.close).not.toHaveBeenCalled();
    });

    it('closes that tab when the server has no link, or the request fails, and raises nothing', async () => {
      const tab = fakeTab();
      vi.spyOn(window, 'open').mockReturnValue(tab as never);
      GET.mockRejectedValueOnce(new Error('offline'));
      click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
      await vi.waitFor(() => expect(tab.close).toHaveBeenCalledTimes(1));
      const tab2 = fakeTab();
      vi.spyOn(window, 'open').mockReturnValue(tab2 as never);
      GET.mockResolvedValueOnce({ error: {}, response: new Response('{}', { status: 404 }) } as never);
      click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
      await vi.waitFor(() => expect(tab2.close).toHaveBeenCalledTimes(1));
      expect(tab.location.replace).not.toHaveBeenCalled();
      expect(told).toHaveBeenCalledTimes(1); // once: the failed request was told by the session client, the 404 is ours
    });

    it.each([[503], [500]])('adds no notice of its own for a %i: the session client has told the person, and the tab is closed', async (status) => {
      const tab = fakeTab();
      vi.spyOn(window, 'open').mockReturnValue(tab as never);
      GET.mockResolvedValueOnce({ error: {}, response: new Response('{}', { status }) } as never);
      click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
      await vi.waitFor(() => expect(tab.close).toHaveBeenCalledTimes(1)); // the answer has been handled
      expect(told).not.toHaveBeenCalled();
    });

    it.each(['account_suspended', 'not_allowed'])('adds no notice for a 403 %s: the client signs the person out, and the sign-in screen says why', async (code) => {
      const tab = fakeTab();
      vi.spyOn(window, 'open').mockReturnValue(tab as never);
      GET.mockResolvedValueOnce({ error: { error: { code } }, response: new Response('{}', { status: 403 }) } as never);
      click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
      await vi.waitFor(() => expect(tab.close).toHaveBeenCalledTimes(1));
      expect(told).not.toHaveBeenCalled();
    });

    it('still says it for an ordinary 403 (no access to that file)', async () => {
      const tab = fakeTab();
      vi.spyOn(window, 'open').mockReturnValue(tab as never);
      GET.mockResolvedValueOnce({ error: { error: { code: 'forbidden' } }, response: new Response('{}', { status: 403 }) } as never);
      click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
      await vi.waitFor(() => expect(told).toHaveBeenCalledWith("That file isn't available"));
      expect(tab.close).toHaveBeenCalledTimes(1);
    });

    it('does nothing more when the browser refused the new tab', async () => {
      const opener = vi.spyOn(window, 'open').mockReturnValue(null);
      click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
      expect(opener).toHaveBeenCalledTimes(1); // the refusal is known inside the click: nothing is requested after it
      expect(GET).not.toHaveBeenCalled();
    });
  });

  it('opens nothing and raises nothing when the request for the link fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    GET.mockRejectedValueOnce(new Error('offline'));
    click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('web.attachment_open_failed'))); // the failure has been handled
    expect(open).not.toHaveBeenCalled();
    expect(told).not.toHaveBeenCalled(); // the session client has already told the person about the failed request: one notice
  });

  it('tells the person once for an answer that has no link in it', async () => {
    GET.mockResolvedValueOnce({ data: {}, response: new Response('{}', { status: 200 }) } as never);
    click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
    await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves other links alone', () => {
    const event = click(harness.root.querySelector('a[href="https://example.test/x"]')!);
    expect(event.defaultPrevented).toBe(false);
    expect(GET).not.toHaveBeenCalled();
  });

  it('opens nothing when the server has no link (no access, deleted)', async () => {
    GET.mockResolvedValueOnce({ error: {}, response: new Response('{}', { status: 404 }) } as never);
    click(harness.root.querySelector(`a[href="attachments/${ID}/plan.pdf"]`)!);
    await vi.waitFor(() => expect(told).toHaveBeenCalledWith("That file isn't available")); // a deleted file or lost access is said, not a flash of a tab
    expect(GET).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});
