import { describe, expect, it } from 'vitest';
import { isCheckedType, isInlineType, typeFromFileName, validateAttachmentMeta } from '../../src/attachments/validate.js';

const limits = { maxBytes: 1000, allowedTypes: ['image/png', 'application/pdf', 'text/plain'] };

describe('validateAttachmentMeta', () => {
  it('is ok at the maximum size and too_large one byte over it', () => {
    expect(validateAttachmentMeta({ size: 1000, contentType: 'image/png' }, limits)).toEqual({ ok: true });
    expect(validateAttachmentMeta({ size: 1001, contentType: 'image/png' }, limits)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses a type that is not in the list, and always SVG and HTML', () => {
    for (const contentType of ['image/svg+xml', 'text/html', 'application/x-msdownload', '', 'image/png; charset=utf-8', ' image/png']) {
      expect(validateAttachmentMeta({ size: 1, contentType }, limits), contentType).toEqual({ ok: false, reason: 'type_not_allowed' });
    }
  });

  it('lower-cases the declared type before it matches', () => {
    expect(validateAttachmentMeta({ size: 1, contentType: 'IMAGE/PNG' }, limits)).toEqual({ ok: true });
  });

  it('refuses the type first: a refused type is refused whatever its size', () => {
    expect(validateAttachmentMeta({ size: 10 ** 9, contentType: 'text/html' }, limits)).toEqual({ ok: false, reason: 'type_not_allowed' });
  });
});

describe('the inline and checked types', () => {
  it('shows only the five raster types inline', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) expect([t, isInlineType(t)]).toEqual([t, true]);
    for (const t of ['application/pdf', 'image/svg+xml', 'text/plain', 'video/mp4', 'video/quicktime', 'image/heic', 'image/png; x=1']) expect([t, isInlineType(t)]).toEqual([t, false]);
  });

  it('checks the bytes of the raster types and of PDF, and of nothing else', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf']) expect([t, isCheckedType(t)]).toEqual([t, true]);
    for (const t of ['text/plain', 'application/zip', 'video/webm', 'video/quicktime', 'image/heic']) expect([t, isCheckedType(t)]).toEqual([t, false]);
  });
});

describe('typeFromFileName', () => {
  it('gives the type of each extension of the allowed types, in any case', () => {
    expect(typeFromFileName('a.PNG')).toBe('image/png');
    const table: [string, string][] = [
      ['a.jpg', 'image/jpeg'], ['a.JPEG', 'image/jpeg'], ['a.gif', 'image/gif'], ['a.webp', 'image/webp'], ['a.avif', 'image/avif'], ['a.pdf', 'application/pdf'],
      ['a.txt', 'text/plain'], ['a.csv', 'text/csv'], ['a.md', 'text/markdown'], ['a.markdown', 'text/markdown'], ['a.zip', 'application/zip'], ['a.mp4', 'video/mp4'], ['a.webm', 'video/webm'],
      ['a.mov', 'video/quicktime'], ['a.MOV', 'video/quicktime'], ['a.heic', 'image/heic'], ['a.HEIC', 'image/heic'],
      ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ];
    for (const [name, type] of table) expect([name, typeFromFileName(name)]).toEqual([name, type]);
  });

  it('gives nothing for another extension, none, or a name that is only an extension of the object prototype', () => {
    for (const name of ['a.exe', 'a.svg', 'a.html', 'noextension', 'a.', 'a.constructor', 'a.__proto__', 'a.toString']) expect([name, typeFromFileName(name)]).toEqual([name, undefined]);
  });

  it('gives a type that validateAttachmentMeta accepts with the default list for every extension it knows', () => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/zip', 'video/mp4', 'video/webm', 'video/quicktime',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'pdf', 'txt', 'csv', 'md', 'markdown', 'docx', 'xlsx', 'pptx', 'zip', 'mp4', 'webm', 'mov']) {
      expect(allowed, ext).toContain(typeFromFileName(`f.${ext}`));
    }
  });
});
