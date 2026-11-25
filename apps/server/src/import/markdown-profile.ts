import { resolveLinkPath } from '@tektum/grimoire-core/import/paths';
import type { ImportProfile, LinkIndex, Target } from './profile.js';

/** A page file; everything else of the archive is a file a page may use. */
const PAGE = /\.(md|markdown)$/i;
/** The page file that stands for its folder. */
const FOLDER_PAGE = /^(index|readme)\.(md|markdown)$/i;
const INDEX_NAMES = ['index.md', 'index.markdown'];

const lines = (text: string): string[] => text.split('\n');

/**
 * Front matter (R10.10) is removed: a YAML block between `---` and `---` (or `...`), or a TOML block between `+++` lines, at the very start (a byte order mark before it goes too).
 * A page that only starts with a horizontal rule, or has an opening line with no closing one, is left exactly as it is: the block must open with a `key: value` (or `key = value`) line.
 */
function stripFrontMatter(markdown: string): string {
  const text = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  const open = /^(---|\+\+\+)[ \t]*\r?\n/.exec(text);
  if (open === null) return markdown;
  const toml = open[1] === '+++';
  let at = open[0].length;
  let first = true;
  while (at <= text.length) {
    const end = text.indexOf('\n', at);
    const line = (end === -1 ? text.slice(at) : text.slice(at, end)).replace(/\r$/, '');
    const closes = toml ? line.trimEnd() === '+++' : line.trimEnd() === '---' || line.trimEnd() === '...';
    if (closes) return end === -1 ? '' : text.slice(end + 1);
    if (first && !(toml ? /^[A-Za-z0-9_"'.-]+[ \t]*=/ : /^[A-Za-z0-9_"'.-][^:\n]*:/).test(line)) return markdown;
    first = false;
    if (end === -1) return markdown;
    at = end + 1;
  }
  return markdown;
}

const plain = (heading: string): string =>
  heading.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*)(.+?)\1/g, '$2').replace(/`/g, '').replace(/\s+/g, ' ').trim();

/** The first level-one heading outside a code fence, or else the first heading of any level. */
function headingOf(markdown: string): string | undefined {
  let fence: string | undefined;
  let firstAny: string | undefined;
  const all = lines(markdown);
  for (let i = 0; i < all.length; i++) {
    const line = (all[i] ?? '').replace(/\r$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker[0] as string;
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    let level = 0;
    let text = '';
    if (atx !== null) { level = (atx[1] as string).length; text = plain(atx[2] ?? ''); } else if (line.trim() !== '' && /^ {0,3}(=+|-+)[ \t]*$/.test((all[i + 1] ?? '').replace(/\r$/, '')) && !/^ {0,3}(=+|-+)[ \t]*$/.test(line) && !/^\s*[-*+] /.test(line)) {
      level = (all[i + 1] ?? '').trim().startsWith('=') ? 1 : 2;
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
  classify: ({ path }) => (PAGE.test(path) && (path.split('/').at(-1) ?? '').length > '.md'.length ? 'page' : 'attachment'),
  titleOf(path, markdown) {
    const heading = headingOf(stripFrontMatter(markdown));
    if (heading !== undefined) return heading;
    return (path.split('/').at(-1) ?? path).replace(PAGE, '');
  },
  parentPathOf(path, lowerPaths) {
    const segments = path.split('/');
    const name = segments.pop() ?? '';
    // The page file of a folder stands for the folder, so it goes under the folder above. When a folder has both an index file and a README, the index file is its page and the
    // README is an ordinary page inside it.
    const folderPage = FOLDER_PAGE.exec(name);
    if (folderPage !== null && segments.length > 0) {
      const readmeBesideIndex = folderPage[1]?.toLowerCase() === 'readme' && lowerPaths !== undefined && INDEX_NAMES.some((n) => lowerPaths.has(`${segments.join('/').toLowerCase()}/${n}`));
      if (!readmeBesideIndex) segments.pop();
    }
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
