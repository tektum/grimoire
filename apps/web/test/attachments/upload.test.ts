import { describe, expect, it, vi } from 'vitest';
import { TOO_MANY_UPLOADS, uploadAttachment } from '../../src/editor/attachments/upload';

const ID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
const PAGE = '99999999-8888-4777-8666-555555555555';
const created = { id: ID, markdownPath: `attachments/${ID}/photo.png`, upload: { method: 'PUT', url: 'https://files.test/put', headers: { 'content-type': 'image/png', 'if-none-match': '*' }, expiresAt: 1 } };
const completed = { id: ID, fileName: 'photo.png', contentType: 'image/png', size: 3, markdownPath: created.markdownPath, pageId: PAGE };
const respond = (status: number, data?: unknown, error?: unknown) => ({ ...(data === undefined ? {} : { data }), ...(error === undefined ? {} : { error }), response: new Response('{}', { status }) });
const file = (name = 'photo.png', type = 'image/png') => new File([new Uint8Array([1, 2, 3])], name, { type });

function setup(over: { create?: unknown; complete?: unknown; put?: Response | Error } = {}) {
  const POST = vi.fn<(path: string, init?: unknown) => Promise<never>>(async (path: string) => (path === '/v1/attachments' ? (over.create ?? respond(201, created)) : (over.complete ?? respond(200, completed))) as never);
  const put = vi.fn(async () => {
    if (over.put instanceof Error) throw over.put;
    return over.put ?? new Response(null, { status: 200 });
  });
  return { POST, put, upload: (f = file()) => uploadAttachment({ api: { POST } as never, put: put as never, pageId: PAGE }, f) };
}

describe('the upload sequence', () => {
  it('creates, then PUTs the bytes with exactly the returned headers and no credentials, then completes, in that order', async () => {
    const order: string[] = [];
    const s = setup();
    s.POST.mockImplementation(async (path: string) => { order.push(`POST ${path}`); return (path === '/v1/attachments' ? respond(201, created) : respond(200, completed)) as never; });
    s.put.mockImplementation(async () => { order.push('PUT'); return new Response(null, { status: 200 }); });
    const result = await s.upload();
    expect(order).toEqual(['POST /v1/attachments', 'PUT', 'POST /v1/attachments/{id}/complete']);
    expect(s.POST.mock.calls[0]).toEqual(['/v1/attachments', { body: { pageId: PAGE, fileName: 'photo.png', contentType: 'image/png', size: 3 } }]);
    expect(s.put).toHaveBeenCalledWith('https://files.test/put', expect.objectContaining({ method: 'PUT', headers: created.upload.headers, credentials: 'omit' }));
    expect(s.POST.mock.calls[1]).toEqual(['/v1/attachments/{id}/complete', { params: { path: { id: ID } } }]);
    expect(result).toEqual({ ok: true, attachment: completed });
  });

  it('names a file with no name and no type', async () => {
    const s = setup();
    await s.upload(new File([new Uint8Array([1])], '', { type: '' }));
    expect(s.POST.mock.calls[0]![1]).toMatchObject({ body: { fileName: 'file', contentType: 'application/octet-stream' } });
  });

  it.each([
    ['413 too_large', respond(413, undefined, { error: { code: 'too_large' } }), 'That file is too large'],
    ['422 type_not_allowed', respond(422, undefined, { error: { code: 'type_not_allowed' } }), "That file type isn't allowed"],
    ['429 rate_limited', respond(429, undefined, { error: { code: 'rate_limited' } }), TOO_MANY_UPLOADS],
    ['an unknown error', respond(500, undefined, { error: { code: 'weird' } }), 'Something went wrong'],
    ['no body', respond(500), 'Something went wrong'],
  ])('says it plainly when creating is refused: %s', async (_name, create, message) => {
    const s = setup({ create });
    const result = await s.upload();
    expect(result).toEqual({ ok: false, message });
    expect(s.put).not.toHaveBeenCalled();
    expect(s.POST).toHaveBeenCalledTimes(1);
  });

  it('says the upload did not finish when the store refuses or cannot be reached, and does not complete', async () => {
    for (const put of [new Response(null, { status: 403 }), new Error('network')]) {
      const s = setup({ put });
      expect(await s.upload()).toEqual({ ok: false, message: "The upload didn't finish. Try again" });
      expect(s.POST).toHaveBeenCalledTimes(1);
    }
  });

  it('says what the server says when completing is refused (the type does not match, the upload is missing)', async () => {
    const s = setup({ complete: respond(422, undefined, { error: { code: 'type_mismatch' } }) });
    expect(await s.upload()).toEqual({ ok: false, message: "The file doesn't look like its type" });
    const t = setup({ complete: respond(409, undefined, { error: { code: 'upload_missing' } }) });
    expect(await t.upload()).toEqual({ ok: false, message: "The upload didn't finish. Try again" });
  });

  it('never throws: a failing API call is a message', async () => {
    const s = setup();
    s.POST.mockRejectedValueOnce(new Error('offline'));
    expect(await s.upload()).toEqual({ ok: false, message: 'Something went wrong' });
  });
});
