import { resolveLinkPath } from '@tektum/grimoire-core/import/paths';
import type { ImportProfile, LinkIndex, Target } from './profile.js';

/** A page file; everything else of the archive is a file a page may use. */
const PAGE = /\.(md|markdown)$/i;
/** The page file that stands for its folder. */
const FOLDER_PAGE = /^(index|readme)\.(md|markdown)$/i;
const INDEX_NAMES = ['index.md', 'index.markdown'];

const lines = (text: string): string[] => text.split('\n');
/** The segments of an archive path as `resolveLinkPath` and the duplicate check read it: `.` and empty segments name nothing. */
const segmentsOf = (path: string): string[] => path.split('/').filter((segment) => segment !== '' && segment !== '.');

/** What a line inside a YAML front matter block can be: blank, a comment, indented (a nested value or a folded text), a list item, or `key:` (with a value or none). */
const YAML_LINE = /^(?:\s*|#.*|[ \t]+.*|-(?:[ \t].*)?|[A-Za-z0-9_"'.-][^:\n]*:(?:[ \t].*)?)$/;
/** The same for TOML: blank, a comment, indented (an array over lines), a closing bracket, a table header, or `key = value`. */
const TOML_LINE = /^(?:\s*|#.*|[ \t]+.*|[\]}].*|\[[^\]\n]*\]|[A-Za-z0-9_"'.-]+[ \t]*=.*)$/;

/**
 * Front matter (R10.10) is removed: a YAML block between `---` and `---` (or `...`), or a TOML block between `+++` lines, at the very start (a byte order mark before it goes
 * too). Every line of the block must be of the shapes the format has, so a page that only starts with a horizontal rule (even with a sentence that has a colon right after it),
 * or has an opening line and no closing one, is left exactly as it is.
 */
function stripFrontMatter(markdown: string): string {
  const text = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  const open = /^(---|\+\+\+)[ \t]*\r?\n/.exec(text);
  if (open === null) return markdown;
  const toml = open[1] === '+++';
  const shape = toml ? TOML_LINE : YAML_LINE;
  let at = open[0].length;
  let sawContent = false;
  while (at <= text.length) {
    const end = text.indexOf('\n', at);
    const line = (end === -1 ? text.slice(at) : text.slice(at, end)).replace(/\r$/, '');
    const closes = toml ? line.trimEnd() === '+++' : line.trimEnd() === '---' || line.trimEnd() === '...';
    // A closed block that has lines but no content (only blanks and comments, a `# Title` between two rules) is a horizontal rule and some text, not front matter; a block with no
    // line at all (`---` and `---` one after the other) is an empty front matter and goes.
    if (closes) return sawContent || at === open[0].length ? (end === -1 ? '' : text.slice(end + 1)) : markdown;
    if (!shape.test(line)) return markdown;
    if (line.trim() !== '' && !line.trimStart().startsWith('#')) sawContent = true;
    if (end === -1) return markdown;
    at = end + 1;
  }
  return markdown;
}

const plain = (heading: string): string =>
  heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*)(.+?)\1/g, '$2').replace(/`/g, '').replace(/\s+/g, ' ').trim();

/** What can be the text of a setext heading: not a quote, a list item, an ATX heading, a fence opener or an indented code line. */
const NOT_SETEXT = /^(?: {4}|\t| {0,3}(?:>|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|#{1,6}(?:[ \t]|$)|`{3}|~{3}))/;

/** The first level-one heading outside a code fence, or else the first heading of any level. */
function headingOf(markdown: string): string | undefined {
  let fence: { readonly char: string; readonly length: number } | undefined;
  let firstAny: string | undefined;
  const all = lines(markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown);
  for (let i = 0; i < all.length; i++) {
    const line = (all[i] ?? '').replace(/\r$/, '');
    if (fence !== undefined) {
      // CommonMark: a fence is closed by a run of the same character at least as long as the opening one, with nothing but spaces after it.
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close !== undefined && close[0] === fence.char && close.length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence cannot have a backtick in its info string (that is inline code).
    if (open !== null && !((open[1] as string)[0] === '`' && (open[2] ?? '').includes('`'))) {
      fence = { char: (open[1] as string)[0] as string, length: (open[1] as string).length };
      continue;
    }
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    let level = 0;
    let text = '';
    const next = (all[i + 1] ?? '').replace(/\r$/, '');
    if (atx !== null) { level = (atx[1] as string).length; text = plain(atx[2] ?? ''); } else if (line.trim() !== '' && /^ {0,3}(=+|-+)[ \t]*$/.test(next) && !NOT_SETEXT.test(line) && !/^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
      level = next.trim().startsWith('=') ? 1 : 2;
      text = plain(line);
    }
    if (level === 0 || text === '') continue;
    if (level === 1) return text;
    firstAny ??= text;
  }
  return firstAny;
}

/** The generic `markdown_zip` profile: folders and Markdown files. A folder with no page file of its own is an empty container page (the engine makes it). */
export const markdownProfile: ImportProfile = {
  source: 'markdown_zip',
  classify: ({ path }) => ((path.split('/').at(-1) ?? '').replace(PAGE, '') !== '' && PAGE.test(path) ? 'page' : 'attachment'),
  titleOf(path, markdown) {
    const heading = headingOf(stripFrontMatter(markdown));
    if (heading !== undefined) return heading;
    return (path.split('/').at(-1) ?? path).replace(PAGE, '');
  },
  folderPathOf(path, lowerPaths) {
    const segments = segmentsOf(path);
    const name = segments.pop() ?? '';
    const folderPage = FOLDER_PAGE.exec(name);
    if (folderPage === null || segments.length === 0) return undefined;
    // When a folder has both an index file and a README, the index file is its page and the README is an ordinary page inside it.
    const readmeBesideIndex = folderPage[1]?.toLowerCase() === 'readme' && lowerPaths !== undefined && INDEX_NAMES.some((n) => lowerPaths.has(`${segments.join('/').toLowerCase()}/${n}`));
    return readmeBesideIndex ? undefined : segments.join('/');
  },
  parentPathOf(path, lowerPaths) {
    const folder = markdownProfile.folderPathOf(path, lowerPaths);
    // The page file of a folder stands for the folder, so it goes under the folder above.
    const segments = folder !== undefined ? segmentsOf(folder) : segmentsOf(path).slice(0, -1);
    if (folder !== undefined) segments.pop();
    return segments.length === 0 ? null : segments.join('/');
  },
  preprocess: (markdown) => stripFrontMatter(markdown),
  resolveLink(url, fromPath, index: LinkIndex): Target | undefined {
    const path = resolveLinkPath(url, fromPath);
    if (path === undefined) return undefined;
    const found = index.byPath.get(path);
    if (found === undefined) return undefined;
    const hash = url.indexOf('#');
    const fragment = hash === -1 ? '' : url.slice(hash + 1);
    return { kind: found.kind, itemId: found.itemId, ...(fragment === '' ? {} : { fragment }) };
  },
};
