import { describe, expect, it, vi } from 'vitest';
import { signedUrlsFrom } from '../../src/editor/attachments/api';

const ID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
const ok = (body: unknown) => ({ data: body, response: new Response('{}', { status: 200 }) });

describe('asking the server for signed links', () => {
  it('posts the ids to /v1/attachments/urls and returns the links by id', async () => {
    const POST = vi.fn(async () => ok({ urls: [{ id: ID, url: 'https://files.test/a', expiresAt: 5 }] }));
    const answer = await signedUrlsFrom({ POST } as never)([ID]);
    expect(POST).toHaveBeenCalledWith('/v1/attachments/urls', { body: { ids: [ID] } });
    expect(answer.get(ID)).toEqual({ url: 'https://files.test/a', expiresAt: 5 });
  });

  it('fails when the server does not answer with success', async () => {
    const POST = vi.fn(async () => ({ error: {}, response: new Response('{}', { status: 503 }) }));
    await expect(signedUrlsFrom({ POST } as never)([ID])).rejects.toThrow('503');
  });
});
