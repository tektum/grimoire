import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentId, placeholderHost } from '../../src/editor/attachments/path';
import { provideAttachments } from '../../src/editor/attachments/host';
import { imageView, imagePlugin } from '../../src/editor/attachments/image-view';
import type { FetchUrls, SignedUrl } from '../../src/editor/attachments/urls';
import { makeEditor, type Harness } from '../tables/support';

const ID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
const SRC = `attachments/${ID}/photo.png`;

describe('which image sources are uploaded files', () => {
  it('maps only attachments/<uuid>/<name>, whatever the case of the id', () => {
    expect(attachmentId(SRC)).toBe(ID);
    expect(attachmentId(`attachments/${ID.toUpperCase()}/a%20b.png`)).toBe(ID);
  });

  it.each([
    './x.png',
    'x.png',
    '/attachments/' + ID + '/a.png',
    `attachments/${ID}`,
    `attachments/${ID}/`,
    `attachments/${ID}/a/b.png`,
    `attachments/not-a-uuid/a.png`,
    `attachments/${ID}/a.png?x=1`,
    `../attachments/${ID}/a.png`,
    `https://files.test/attachments/${ID}/a.png`,
    'data:image/png;base64,AAAA',
    '',
  ])('does not map %j', (src) => {
    expect(attachmentId(src)).toBeNull();
  });

  it('names the host of an address, and says what else it is when there is none', () => {
    expect(placeholderHost('https://evil.test/p.png')).toBe('evil.test');
    expect(placeholderHost('http://a.example:8080/x')).toBe('a.example');
    expect(placeholderHost('//photos.example.com/x.png')).toBe('photos.example.com'); // no scheme, a host: external too
    expect(placeholderHost('data:image/png;base64,AAAA')).toBe('embedded data');
    expect(placeholderHost('./x.png')).toBe('./x.png');
    expect(placeholderHost(`./${'a'.repeat(100)}.png`).length).toBeLessThanOrEqual(60);
  });
});

describe('the image node view', () => {
  let harness: Harness;
  const link = (n: number, expiresAt = Date.now() + 3_600_000): SignedUrl => ({ url: `https://files.test/${n}?sig=${n}`, expiresAt });
  let fetchUrls: ReturnType<typeof vi.fn<FetchUrls>>;
  let dispose: () => void;

  const imageNode = (src: string, alt = 'a photo') => harness.view.state.schema.nodes['image']!.create({ src, alt });
  const viewOf = (src: string, alt?: string) => imageView(imageNode(src, alt), harness.view);
  const update = (view: ReturnType<typeof imageView>, node: ReturnType<typeof imageNode>): boolean | undefined => view.update?.(node, [], {} as never);
  // Waits on what is observable, never on a count of turns: the answer, the request made, the state the node ends in. `turn` is a whole turn of the event loop, for
  // checking that something did NOT happen after everything queued has run.
  const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const srcOf = (view: ReturnType<typeof imageView>): string | null => (view.dom as HTMLElement).querySelector('img')?.getAttribute('src') ?? null;
  const untilSrc = (view: ReturnType<typeof imageView>, expected?: string) => vi.waitFor(() => (expected === undefined ? expect(srcOf(view)).not.toBeNull() : expect(srcOf(view)).toBe(expected)));
  const untilCalls = (n: number) => vi.waitFor(() => expect(fetchUrls).toHaveBeenCalledTimes(n));
  const untilState = (view: ReturnType<typeof imageView>, state: string) => vi.waitFor(() => expect((view.dom as HTMLElement).dataset['state']).toBe(state));

  beforeEach(async () => {
    harness = await makeEditor('text\n', imagePlugin);
    let n = 0;
    fetchUrls = vi.fn<FetchUrls>(async (ids: string[]) => new Map(ids.map((id) => [id, link((n += 1))] as const)));
    dispose = provideAttachments(harness.root, { fetchUrls });
  });
  afterEach(async () => {
    dispose();
    await harness.destroy();
    vi.useRealTimers();
  });

  it('shows an uploaded file through its signed link, and says nothing is there until the link has come', async () => {
    const view = viewOf(SRC);
    const dom = view.dom as HTMLElement;
    expect(dom.dataset['state']).toBe('loading');
    expect(dom.querySelector('img')?.getAttribute('src')).toBeNull();
    await untilSrc(view);
    const img = dom.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://files.test/1?sig=1');
    expect(img.getAttribute('alt')).toBe('a photo');
    img.dispatchEvent(new Event('load'));
    expect(dom.dataset['state']).toBe('ready');
    expect(fetchUrls).toHaveBeenCalledWith([ID]);
  });

  it('asks once for all the images of a page that load together', async () => {
    const other = '11111111-2222-4333-8444-555555555555';
    viewOf(SRC);
    viewOf(`attachments/${other}/b.png`);
    await untilCalls(1);
    await turn();
    expect(fetchUrls).toHaveBeenCalledTimes(1);
    expect(fetchUrls.mock.calls[0]![0]).toEqual([ID, other]);
  });

  it('refreshes the link once when the image fails to load, and shows the new one without a reload', async () => {
    const view = viewOf(SRC);
    const dom = view.dom as HTMLElement;
    await untilSrc(view);
    const img = dom.querySelector('img')!;
    img.dispatchEvent(new Event('error')); // the link expired, or the store refused it
    await untilSrc(view, 'https://files.test/2?sig=2');
    expect(fetchUrls).toHaveBeenCalledTimes(2);
    img.dispatchEvent(new Event('load'));
    expect(dom.dataset['state']).toBe('ready');
  });

  it('does not loop: a second failure right after a refresh says the image could not be loaded', async () => {
    const view = viewOf(SRC);
    const dom = view.dom as HTMLElement;
    await untilSrc(view);
    const img = dom.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    await untilSrc(view, 'https://files.test/2?sig=2');
    img.dispatchEvent(new Event('error'));
    await untilState(view, 'failed');
    await turn();
    expect(fetchUrls).toHaveBeenCalledTimes(2);
    expect(dom.dataset['state']).toBe('failed');
    expect(dom.textContent).toContain("Image couldn't be loaded");
  });

  it('allows one error-driven refresh between two successful loads, however long the answers take', async () => {
    vi.useFakeTimers();
    const view = viewOf(SRC);
    const dom = view.dom as HTMLElement;
    await vi.advanceTimersByTimeAsync(0);
    const img = dom.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(60_000); // a slow network: much longer than any time guard
    img.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(dom.dataset['state']).toBe('failed');
    expect(fetchUrls).toHaveBeenCalledTimes(2);
  });

  it('allows another refresh after an image has loaded again', async () => {
    const view = viewOf(SRC);
    const dom = view.dom as HTMLElement;
    await untilSrc(view);
    const img = dom.querySelector('img')!;
    img.dispatchEvent(new Event('error'));
    await untilSrc(view, 'https://files.test/2?sig=2');
    img.dispatchEvent(new Event('load'));
    img.dispatchEvent(new Event('error'));
    await untilCalls(3);
    expect(dom.dataset['state']).not.toBe('failed');
  });

  it('says so when no link comes (the server has none for the id)', async () => {
    fetchUrls.mockResolvedValueOnce(new Map());
    const view = viewOf(SRC);
    await untilState(view, 'failed');
  });

  it('refreshes the link by itself before it expires', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    fetchUrls.mockResolvedValueOnce(new Map([[ID, link(7, now + 100_000)]]));
    const view = viewOf(SRC);
    await vi.advanceTimersByTimeAsync(0);
    const img = (view.dom as HTMLElement).querySelector('img')!;
    img.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchUrls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); // inside the margin of the end: due
    expect(fetchUrls).toHaveBeenCalledTimes(2);
    expect(img.getAttribute('src')).toBe('https://files.test/1?sig=1'); // the new link replaced link 7
  });

  it.each([
    ['https://evil.test/p.png', 'External image not loaded: evil.test'],
    ['data:image/png;base64,AAAA', 'External image not loaded: embedded data'],
    ['./x.png', 'External image not loaded: ./x.png'],
  ])('puts a placeholder in place of %j, with no img element and so no request', async (src, text) => {
    const view = viewOf(src);
    const dom = view.dom as HTMLElement;
    expect(dom.textContent).toBe(text);
    expect(dom.dataset['state']).toBe('external');
    expect(dom.querySelector('img')).toBeNull();
    await turn();
    expect(fetchUrls).not.toHaveBeenCalled();
  });

  it('treats an address with no scheme but a host (//host/path) as external, with the host linked', () => {
    const dom = viewOf('//photos.example.com/x.png').dom as HTMLElement;
    expect(dom.dataset['state']).toBe('external');
    expect(dom.textContent).toBe('External image not loaded: photos.example.com');
    expect(dom.querySelector('a')?.getAttribute('href')).toBe('https://photos.example.com/x.png');
    expect(dom.querySelector('img')).toBeNull();
  });

  it('carries the title of the image onto the img, and follows a change of it', async () => {
    const titled = (title: string) => harness.view.state.schema.nodes['image']!.create({ src: SRC, alt: 'a', title });
    const view = imageView(titled('Caption'), harness.view);
    await untilSrc(view);
    const img = (view.dom as HTMLElement).querySelector('img')!;
    expect(img.getAttribute('title')).toBe('Caption');
    update(view, titled('Other'));
    expect(img.getAttribute('title')).toBe('Other');
    update(view, titled(''));
    expect(img.hasAttribute('title')).toBe(false);
  });

  it('does not replace in a loop a link that is already near its end (a clock ahead of the server)', async () => {
    vi.useFakeTimers();
    fetchUrls.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, link(1, Date.now() + 10_000)] as const)));
    const view = viewOf(SRC);
    await vi.advanceTimersByTimeAsync(0);
    (view.dom as HTMLElement).querySelector('img')!.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchUrls).toHaveBeenCalledTimes(1);
  });

  it('tries a refresh before expiry again when it fails, three more times, and then leaves the image as it is', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    fetchUrls.mockResolvedValueOnce(new Map([[ID, link(7, now + 100_000)]]));
    fetchUrls.mockRejectedValue(new Error('offline'));
    const view = viewOf(SRC);
    await vi.advanceTimersByTimeAsync(0);
    const img = (view.dom as HTMLElement).querySelector('img')!;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(fetchUrls).toHaveBeenCalledTimes(2); // the due refresh failed
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchUrls).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchUrls).toHaveBeenCalledTimes(5);
    expect(img.getAttribute('src')).toBe('https://files.test/7?sig=7');
  });

  it('a failed image stays failed: an answer still on its way does not bring it back', async () => {
    let release: (m: Map<string, SignedUrl>) => void = () => undefined;
    const view = viewOf(SRC);
    const dom = view.dom as HTMLElement;
    await untilSrc(view, 'https://files.test/1?sig=1');
    fetchUrls.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const img = dom.querySelector('img')!;
    img.dispatchEvent(new Event('error')); // asks for a replacement, which is slow
    await untilCalls(2); // the request is out: the answer can now be delivered
    img.dispatchEvent(new Event('error')); // fails again before it came
    expect(dom.dataset['state']).toBe('failed');
    release(new Map([[ID, link(9)]]));
    await turn(); // the answer has been delivered and handled
    expect(dom.dataset['state']).toBe('failed');
    expect(img.getAttribute('src')).toBe('https://files.test/1?sig=1'); // the late link did not reach the image the node had
    expect(srcOf(view)).toBeNull(); // and the node holds no image now
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.textContent).toContain("Image couldn't be loaded");
  });

  it('links the host of a web address by the one link rule, and not a data address', () => {
    const web = (viewOf('https://evil.test/p.png').dom as HTMLElement).querySelector('a');
    expect(web?.getAttribute('href')).toBe('https://evil.test/p.png');
    expect(web?.getAttribute('rel')).toBe('noopener noreferrer');
    expect((viewOf('data:image/png;base64,AAAA').dom as HTMLElement).querySelector('a')).toBeNull();
  });

  it('is a node the person does not type into, and ignores its own changes', () => {
    const view = viewOf(SRC);
    expect((view.dom as HTMLElement).getAttribute('contenteditable')).toBe('false');
    expect(view.ignoreMutation?.({} as never)).toBe(true);
  });

  it('follows a change of the source, and keeps the same view for a change of the alt text', async () => {
    const view = viewOf(SRC, 'one');
    await untilSrc(view);
    expect(update(view, imageNode(SRC, 'two'))).toBe(true);
    expect((view.dom as HTMLElement).querySelector('img')?.getAttribute('alt')).toBe('two');
    expect(update(view, imageNode('https://evil.test/p.png'))).toBe(true);
    expect((view.dom as HTMLElement).dataset['state']).toBe('external');
    expect(update(view, harness.view.state.schema.nodes['paragraph']!.create())).toBe(false);
  });

  it('stops its timer and ignores a late answer once it is destroyed', async () => {
    let release: (m: Map<string, SignedUrl>) => void = () => undefined;
    fetchUrls.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const view = viewOf(SRC);
    view.destroy?.();
    release(new Map([[ID, link(9)]]));
    await turn();
    expect((view.dom as HTMLElement).querySelector('img')).toBeNull();
  });

  it('a page with no attachments host (an editor with no page) says the image could not be loaded', async () => {
    dispose();
    const view = viewOf(SRC);
    expect((view.dom as HTMLElement).dataset['state']).toBe('failed'); // no host: failed at once
  });
});

describe('the image plugin in a real editor', () => {
  it('renders the placeholder for an external image from Markdown, and never an img', async () => {
    const harness = await makeEditor('![evil](https://evil.test/p.png)\n', imagePlugin);
    expect(harness.root.querySelector('img:not(.ProseMirror-separator)')).toBeNull();
    expect(harness.root.textContent).toContain('External image not loaded: evil.test');
    await harness.destroy();
  });

  it('keeps the Markdown of an image as it was', async () => {
    const harness = await makeEditor(`![a photo](${SRC})\n`, imagePlugin);
    expect(harness.markdown().trim()).toBe(`![a photo](${SRC})`);
    await harness.destroy();
  });
});
