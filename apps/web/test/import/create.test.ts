import { describe, expect, it, vi } from 'vitest';
import { createImport, ImportError } from '../../src/import/api';

interface Reply { readonly data: unknown; readonly response: Response }
const body = { collectionId: 'c1', fileName: 'big.zip', size: 5, profile: 'markdown_zip' as const };
const reply = (data: unknown, status = 201): Reply => ({ data, response: new Response(null, { status }) });
const multipart = { id: 'imp9', uploads: [{ index: 0, upload: { kind: 'multipart', partSize: 67_108_864, partCount: 70 } }] };

describe('createImport, when the API answers with a file that goes up in parts (this screen does not send those yet)', () => {
  it('gives up the import the API made, so that nothing is left open, and says the create failed', async () => {
    const POST = vi.fn<(path: string, init?: unknown) => Promise<Reply>>((path) => Promise.resolve(path === '/v1/imports' ? reply(multipart) : reply({ status: 'failed' }, 200)));
    await expect(createImport({ POST } as never, body)).rejects.toMatchObject({ name: 'Error', step: 'create' });
    expect(POST.mock.calls.map((call) => call[0])).toEqual(['/v1/imports', '/v1/imports/{id}/abort']);
    expect(POST.mock.calls[1]?.[1]).toEqual({ params: { path: { id: 'imp9' } } });
  });

  it('still says the create failed when the abort does not go through', async () => {
    const POST = vi.fn((path: string) => (path === '/v1/imports' ? Promise.resolve(reply(multipart)) : Promise.reject(new Error('network'))));
    const failed = await createImport({ POST } as never, body).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ImportError);
    expect(failed).toMatchObject({ step: 'create' });
  });

  it('aborts nothing for an answer that holds no import', async () => {
    const POST = vi.fn(() => Promise.resolve(reply({ unexpected: true })));
    await expect(createImport({ POST } as never, body)).rejects.toBeInstanceOf(ImportError);
    expect(POST).toHaveBeenCalledTimes(1);
  });
});
