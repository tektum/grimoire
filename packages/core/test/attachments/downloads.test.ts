import { describe, expect, it } from 'vitest';
import { DOWNLOAD_TTL_SECONDS, downloadOverrides, signedDownload } from '../../src/attachments/downloads.js';
import { NOW, row, setup } from './support.js';

describe('downloadOverrides: from the row alone', () => {
  it('shows a raster image inline under its own type, and as an attachment under its own type when a download is asked for', () => {
    for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(downloadOverrides({ contentType }, false), contentType).toEqual({ disposition: 'inline', contentType });
      expect(downloadOverrides({ contentType }, true), contentType).toEqual({ disposition: 'attachment', contentType });
    }
  });

  it('serves everything else as an attachment of type application/octet-stream, whatever was asked', () => {
    for (const contentType of ['application/pdf', 'text/plain', 'text/csv', 'application/zip', 'video/mp4', 'image/svg+xml']) {
      for (const download of [false, true]) expect([contentType, downloadOverrides({ contentType }, download)]).toEqual([contentType, { disposition: 'attachment', contentType: 'application/octet-stream' }]);
    }
  });
});

describe('signedDownload', () => {
  it('signs the key of the row for 300 seconds with the forced disposition, type and file name', async () => {
    const { files } = setup();
    const png = row({ id: 'a', fileName: 'p.png' });
    const result = await signedDownload(files, png, false);
    expect(result.expiresAt).toBe(NOW + DOWNLOAD_TTL_SECONDS * 1000);
    expect(result.url).toContain(png.key);
    expect(files.signed.at(-1)).toMatchObject({ kind: 'download', key: png.key, disposition: 'inline', contentType: 'image/png', fileName: 'p.png' });
    await signedDownload(files, row({ id: 'b', contentType: 'application/pdf', fileName: 'd.pdf' }), false);
    expect(files.signed.at(-1)).toMatchObject({ disposition: 'attachment', contentType: 'application/octet-stream', fileName: 'd.pdf' });
    expect(DOWNLOAD_TTL_SECONDS).toBe(300);
  });
});
