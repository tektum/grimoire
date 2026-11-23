const MAX_BYTES = 255;
/** Extensions a browser or a server may run or render as a page; one of them gets `.txt` appended, so the name no longer ends in it. */
const SCRIPTABLE = new Set(['html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'js', 'mjs', 'hta']);
/** The most the extension (with a `.txt`) may take of the 255 bytes: a longer one is not an extension, it is part of the name. */
const MAX_SUFFIX_BYTES = 64;

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** The longest prefix of `text` that fits in `limit` UTF-8 bytes, cut between characters. */
function fit(text: string, limit: number): string {
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = bytesOf(char);
    if (used + size > limit) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * The name a file is kept and offered under (contracts section 4): normalised (NFC), with `/`, `\`, control characters and `:*?"<>|` replaced by `_`, leading
 * dots and spaces stripped, `file` when nothing is left, at most 255 UTF-8 bytes with the extension kept, and `.txt` appended to an extension a browser could run
 * or show as a page. The name is data: the key of the object never contains it.
 */
export function cleanFileName(name: string): string {
  const cleaned = name.normalize('NFC').replace(/\p{Cs}/gu, '\ufffd').replace(/[/\\\p{Cc}:*?"<>|]/gu, '_').replace(/^[. ]+/, '');
  if (cleaned === '') return 'file';
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  const suffix = SCRIPTABLE.has(extension.slice(1).toLowerCase()) ? `${extension}.txt` : extension;
  if (bytesOf(suffix) > MAX_SUFFIX_BYTES) return fit(cleaned, MAX_BYTES);
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  return `${fit(stem, MAX_BYTES - bytesOf(suffix))}${suffix}`;
}
