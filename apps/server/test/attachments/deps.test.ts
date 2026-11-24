import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeAttachmentRepo } from '@tektum/grimoire-core/testing/fake-attachment-repo';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { PartialFileDeletion } from '@tektum/grimoire-core/pages/purge';
import { attachmentDeps, deleteObjects, sniffType } from '../../src/attachments/deps.js';

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array<number>(32).fill(0)]);
const FILES = { endpoint: 'http://s3.invalid', publicEndpoint: 'http://s3.invalid', publicOrigin: 'http://s3.invalid', bucket: 'b', accessKey: 'a', secretKey: 's', region: 'r', addressing: 'path' as const, createOnlyHeader: 'if-none-match' as const, corsMode: 'external' as const, maxBytes: 10, allowedTypes: ['image/png'], pendingMaxPerUser: 1 };

describe('sniffType: the type the first bytes show', () => {
  it('knows the checked types by their signatures', async () => {
    expect(await sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52))).toBe('image/png');
    expect(await sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(await sniffType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
    expect(await sniffType(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('shows nothing for text, and for HTML or SVG pretending to be an image', async () => {
    expect(await sniffType(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeUndefined();
    expect(await sniffType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).not.toBe('image/png');
    expect(await sniffType(new Uint8Array(0))).toBeUndefined();
  });
});

describe('attachmentDeps', () => {
  const http = { attachments: new FakeAttachmentRepo(), clock: { now: () => 5 } };

  it('is undefined without a store, and without the files settings', () => {
    expect(attachmentDeps({ ...http, config: makeFakeConfig({ files: FILES }) })).toBeUndefined();
    expect(attachmentDeps({ ...http, files: new FakeFileStorage(), config: makeFakeConfig() })).toBeUndefined();
  });

  it('gives the repository, the store, the clock, version 7 ids and the limits when both are there', () => {
    const made = attachmentDeps({ ...http, files: new FakeFileStorage(), config: makeFakeConfig({ files: FILES }) });
    expect(made?.limits).toEqual({ maxBytes: 10, allowedTypes: ['image/png'], pendingMaxPerUser: 1 });
    expect(made?.deps.now()).toBe(5);
    expect(made?.deps.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('deleteObjects', () => {
  it('removes each object, treats a missing one as done, and does nothing without a store', async () => {
    const files = new FakeFileStorage();
    await files.put('attachments/a', new Uint8Array([1]), { size: 1, contentType: 'image/png' });
    await files.put('attachments/b', new Uint8Array([1]), { size: 1, contentType: 'image/png' });
    await deleteObjects(files)(['attachments/a', 'attachments/missing', 'attachments/b']);
    await expect(files.head('attachments/a')).rejects.toMatchObject({ kind: 'not-found' });
    await expect(files.head('attachments/b')).rejects.toMatchObject({ kind: 'not-found' });
    await expect(deleteObjects(undefined)(['attachments/a'])).resolves.toBeUndefined();
  });

  it('stops at the first key the store fails on and reports which keys it had removed, with the failure as the cause', async () => {
    const files = new FakeFileStorage();
    const failing = { ...files, delete: async (key: string) => { if (key === 'attachments/b') throw new Error('store down'); await files.delete(key); } } as unknown as FakeFileStorage;
    await files.put('attachments/a', new Uint8Array([1]), { size: 1, contentType: 'image/png' });
    const error = await deleteObjects(failing)(['attachments/a', 'attachments/b', 'attachments/c']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialFileDeletion);
    expect((error as PartialFileDeletion).removed).toEqual(['attachments/a']);
    expect(((error as PartialFileDeletion).cause as Error).message).toBe('store down');
    await expect(files.head('attachments/a')).rejects.toMatchObject({ kind: 'not-found' });
  });
});
