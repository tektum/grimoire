import { describe, expect, it } from 'vitest';
import { cleanFileName } from '../../src/attachments/file-name.js';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('cleanFileName', () => {
  it('replaces separators, control characters and the characters a file system refuses with an underscore', () => {
    expect(cleanFileName('a/b')).toBe('a_b');
    expect(cleanFileName('a\\b')).toBe('a_b');
    expect(cleanFileName('a\r\nb')).toBe('a__b');
    expect(cleanFileName('a\u0000b\u007fc')).toBe('a_b_c');
    expect(cleanFileName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('strips leading dots and spaces, so a name cannot be hidden or climb out of a folder', () => {
    expect(cleanFileName('../../x')).toBe('_.._x');
    expect(cleanFileName('.hidden')).toBe('hidden');
    expect(cleanFileName('  .. a.txt')).toBe('a.txt');
  });

  it('is `file` when nothing is left', () => {
    for (const name of ['', '   ', '...', ' . . ']) expect([name, cleanFileName(name)]).toEqual([name, 'file']);
  });

  it('normalises to NFC and repairs a lone surrogate', () => {
    expect(cleanFileName('e\u0301.txt')).toBe('\u00e9.txt');
    expect(cleanFileName('a\ud800b')).toBe('a\ufffdb');
  });

  it('keeps a name of up to 255 bytes and cuts a longer one to 255 bytes with its extension, between characters', () => {
    const exact = `${'a'.repeat(251)}.png`;
    expect(cleanFileName(exact)).toBe(exact);
    const long = cleanFileName(`${'b'.repeat(300)}.png`);
    expect([bytes(long), long.endsWith('.png'), long.length]).toEqual([255, true, 255]);
    const wide = cleanFileName(`${'\u00e9'.repeat(300)}.pdf`);
    expect(bytes(wide)).toBeLessThanOrEqual(255);
    expect(wide.endsWith('.pdf')).toBe(true);
    expect(wide).not.toContain('\ufffd');
    expect(cleanFileName('\u{1f600}'.repeat(100)).length).toBeLessThanOrEqual(127);
  });

  it('appends .txt to an extension a browser could run or show as a page, in any case, inside the 255 bytes', () => {
    for (const ext of ['html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'js', 'mjs', 'hta', 'HTML', 'Svg']) {
      expect([ext, cleanFileName(`x.${ext}`)]).toEqual([ext, `x.${ext}.txt`]);
    }
    const long = cleanFileName(`${'c'.repeat(300)}.html`);
    expect([bytes(long), long.endsWith('.html.txt')]).toEqual([255, true]);
    expect(cleanFileName('a.tar.gz')).toBe('a.tar.gz');
  });

  it('treats a very long extension as part of the name, not as an extension to keep', () => {
    const name = `a.${'x'.repeat(300)}`;
    const out = cleanFileName(name);
    expect([bytes(out), out.startsWith('a.xxx')]).toEqual([255, true]);
  });

  it('strips trailing dots and spaces, which a download sanitiser would drop and so uncover an extension', () => {
    expect(cleanFileName('x.html.')).toBe('x.html.txt');
    expect(cleanFileName('x.html ')).toBe('x.html.txt');
    expect(cleanFileName('x.svg. . ')).toBe('x.svg.txt');
    expect(cleanFileName('a. ')).toBe('a');
    expect(cleanFileName('report .pdf')).toBe('report .pdf');
  });

  it('checks the extension the name ends in after the cut: a cut that leaves .html or .js at the end gets its .txt', () => {
    const exposed = cleanFileName(`${'x'.repeat(250)}.html${'y'.repeat(70)}`);
    expect([bytes(exposed), exposed.endsWith('.html.txt')]).toEqual([255, true]);
    const script = cleanFileName(`${'\u00e9'.repeat(126)}.js${'z'.repeat(80)}`);
    expect(bytes(script)).toBeLessThanOrEqual(255);
    expect(script.endsWith('.js.txt')).toBe(true);
    // A long extension that is not one of the list stays as it is.
    expect(cleanFileName(`a.${'q'.repeat(100)}`).startsWith('a.qqq')).toBe(true);
  });
});
