import { describe, expect, it } from 'vitest';
import { attachmentKey, markdownPathFor } from '../../src/attachments/key.js';

const ID = '0192f2b4-7c1e-7a3b-8f0d-5b6c7d8e9f01';

describe('attachmentKey', () => {
  it('is the id under attachments/ and holds nothing a user wrote', () => {
    expect(attachmentKey(ID)).toBe(`attachments/${ID}`);
  });
});

describe('markdownPathFor', () => {
  it('is attachments/<id>/<name> for a plain name', () => {
    expect(markdownPathFor(ID, 'report.pdf')).toBe(`attachments/${ID}/report.pdf`);
  });

  it('cleans the name first and encodes each segment, so the path is one relative path in a Markdown link', () => {
    const path = markdownPathFor(ID, "a b#c%d(e)[f]!'.png");
    expect(path).toBe(`attachments/${ID}/a%20b%23c%25d%28e%29%5Bf%5D%21%27.png`);
    expect(path).not.toMatch(/[\s()[\]!'#]|%(?![0-9A-F]{2})/);
    expect(decodeURIComponent(path.split('/')[2] as string)).toBe("a b#c%d(e)[f]!'.png");
  });

  it('has no path separator in the name, and a colon cannot make it read as a scheme (cleaning turns it into an underscore)', () => {
    expect(markdownPathFor(ID, '../../etc/passwd').split('/')).toHaveLength(3);
    expect(markdownPathFor(ID, 'javascript:alert(1).txt')).toBe(`attachments/${ID}/javascript_alert%281%29.txt`);
  });

  it('gives a dangerous extension its .txt, and a dotted name its stripped form', () => {
    expect(markdownPathFor(ID, 'x.svg')).toBe(`attachments/${ID}/x.svg.txt`);
    expect(markdownPathFor(ID, '.hidden')).toBe(`attachments/${ID}/hidden`);
  });
});
