import { markdownProfile } from '../markdown-profile.js';
import type { ImportProfile } from '../profile.js';
import { convertConstructs } from './constructs.js';
import { resolveNotionLink } from './links.js';
import { csvToMarkdownTable } from './table.js';
import { idOf, splitName, titleOf, withoutTitleLine } from './names.js';

/** A path without `.` and empty segments, as the engine and `resolveLinkPath` read it. */
const segmentsOf = (path: string): string[] => path.split('/').filter((segment) => segment !== '' && segment !== '.');

/** The folders of an archive (lower-cased, as `lowerPaths` holds its files), once for each set of paths. */
const folderSets = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();
function foldersOf(lowerPaths: ReadonlySet<string>): ReadonlySet<string> {
  let folders = folderSets.get(lowerPaths);
  if (folders === undefined) {
    const made = new Set<string>();
    for (const p of lowerPaths) { const s = p.split('/'); for (let i = 1; i < s.length; i++) made.add(s.slice(0, i).join('/')); }
    folders = made;
    folderSets.set(lowerPaths, folders);
  }
  return folders;
}

/** The path of a page or a database without its ending (`.md`, `.markdown`; a database's `_all.csv`, or `.csv` when it has no `_all` one), from a lower-cased path; else undefined. */
function stemOf(lowerPath: string, lowerPaths: ReadonlySet<string>): string | undefined {
  if (/\.(md|markdown)$/.test(lowerPath)) return lowerPath.replace(/\.(md|markdown)$/, '');
  if (lowerPath.endsWith('_all.csv')) return lowerPath.slice(0, -'_all.csv'.length);
  if (lowerPath.endsWith('.csv') && !lowerPaths.has(`${lowerPath.slice(0, -'.csv'.length)}_all.csv`)) return lowerPath.slice(0, -'.csv'.length);
  return undefined;
}

/**
 * How many pages and databases of a folder are named `X` once their id is taken off, by `<folder>/x` (lower-cased), once for each set of paths: a database stands for the folder
 * of its row pages as a page does for its children's (decision 167).
 */
const nameCounts = new WeakMap<ReadonlySet<string>, ReadonlyMap<string, number>>();
function pagesNamed(lowerPaths: ReadonlySet<string>): ReadonlyMap<string, number> {
  let counts = nameCounts.get(lowerPaths);
  if (counts === undefined) {
    const made = new Map<string, number>();
    for (const p of lowerPaths) {
      const stem = stemOf(p, lowerPaths);
      if (stem === undefined) continue;
      const s = stem.split('/');
      const { base, id } = splitName(s.pop() ?? '');
      if (id === undefined || base === '') continue;
      const key = [...s, base].join('/');
      made.set(key, (made.get(key) ?? 0) + 1);
    }
    counts = made;
    nameCounts.set(lowerPaths, counts);
  }
  return counts;
}

/**
 * The `notion_md_csv` profile (M7 contracts section 4, Notion rules; M7-T06): an export of Notion, read with the rules of `notion/`. Every rule is marked `constructed: [F§6]` until
 * M7-T08 confirms it against a real export.
 */
export const notionProfile: ImportProfile = {
  source: 'notion_md_csv',
  /**
   * A page file is a page; a database's CSV is the database (`database_csv`, decision 112: it becomes a page holding its table): `X <id>_all.csv`, or `X <id>.csv` when the export has
   * no `_all.csv` of it (contracts section 4: the `_all` one is preferred; a real export has only that one). Everything else is a file a page may use.
   */
  classify(entry, lowerPaths) {
    const kind = markdownProfile.classify(entry);
    if (kind !== 'attachment' || !/\.csv$/i.test(entry.path) || idOf(entry.path) === undefined) return kind;
    if (/_all\.csv$/i.test(entry.path)) return 'database_csv';
    const all = segmentsOf(entry.path).join('/').replace(/\.csv$/i, '_all.csv').normalize('NFC').toLowerCase();
    return lowerPaths?.has(all) === true ? 'attachment' : 'database_csv';
  },
  titleOf,
  /** A page goes under the folder it sits in; which page stands for that folder is `folderPathOf`'s answer. */
  parentPathOf(path) {
    const folder = segmentsOf(path).slice(0, -1);
    return folder.length === 0 ? null : folder.join('/');
  },
  /**
   * The folder a page or a database stands for, so that the pages in it are its children: `X <id>/` beside `X <id>.md` (constructed: [F§6]), or `X/`, the name without the id, as a
   * real export names it (M7-T08); a database's `X <id>_all.csv` stands for the folder of its row pages the same way (decision 167). `X.md` owns `X/` as in any zip, so a page
   * `X <id>.md` beside it does not. A folder `X/` beside two pages or databases named `X` belongs to neither (which one it is cannot be read from the names): it stays an empty page
   * of its own. The name is split lower-cased, as `pagesNamed` counts it: folders are matched without case, the id too.
   */
  folderPathOf(path, lowerPaths) {
    const segments = segmentsOf(path);
    const stem = (segments.pop() ?? '').replace(/(\.(md|markdown)|(_all)?\.csv)$/i, '');
    const dir = segments.join('/');
    const at = (name: string): string => (dir === '' ? name : `${dir}/${name}`);
    const { base, id } = splitName(stem.normalize('NFC').toLowerCase());
    if (id === undefined || base === '' || lowerPaths === undefined) return at(stem);
    const folders = foldersOf(lowerPaths);
    if (folders.has(at(stem).normalize('NFC').toLowerCase())) return at(stem);
    const bare = at(base).normalize('NFC').toLowerCase();
    const plain = lowerPaths.has(`${bare}.md`) || lowerPaths.has(`${bare}.markdown`);
    if (!folders.has(bare) || plain || (pagesNamed(lowerPaths).get(bare) ?? 0) > 1) return at(stem);
    return at(base);
  },
  /** The folders `X/` beside exactly one page and one database named `X`, and no `X.md`: their pages are the database's rows and the page's own (decision 167). */
  sharedFoldersOf(pagePaths, lowerPaths) {
    const folders = foldersOf(lowerPaths);
    const named = new Map<string, { pages: string[]; databases: string[] }>();
    for (const path of pagePaths) {
      const lower = segmentsOf(path).join('/').normalize('NFC').toLowerCase();
      const stem = stemOf(lower, lowerPaths);
      if (stem === undefined) continue;
      const s = stem.split('/');
      const { base, id } = splitName(s.pop() ?? '');
      if (id === undefined || base === '') continue;
      const key = [...s, base].join('/');
      const both = named.get(key) ?? { pages: [], databases: [] };
      (/\.(md|markdown)$/.test(lower) ? both.pages : both.databases).push(path);
      named.set(key, both);
    }
    const shared = new Map<string, { page: string; database: string }>();
    for (const [key, { pages, databases }] of named) {
      const [page] = pages;
      const [database] = databases;
      if (page !== undefined && database !== undefined && pages.length === 1 && databases.length === 1 && folders.has(key) && !lowerPaths.has(`${key}.md`) && !lowerPaths.has(`${key}.markdown`)) shared.set(key, { page, database });
    }
    return shared;
  },
  /** The pages `X <id>.md` of a folder `X/` beside several of them, and no `X.md` (`folderPathOf` gives the folder to none of them). A database is no claimant. */
  claimantsOf(pagePaths, lowerPaths) {
    const folders = foldersOf(lowerPaths);
    const claimants = new Map<string, string[]>();
    for (const path of pagePaths) {
      if (!/\.(md|markdown)$/i.test(path)) continue;
      const segments = segmentsOf(path);
      const { base, id } = splitName((segments.pop() ?? '').replace(/\.(md|markdown)$/i, '').normalize('NFC').toLowerCase());
      if (id === undefined || base === '') continue;
      const bare = [...segments, base].join('/').normalize('NFC').toLowerCase();
      if (!folders.has(bare) || lowerPaths.has(`${bare}.md`) || lowerPaths.has(`${bare}.markdown`)) continue;
      claimants.set(bare, [...(claimants.get(bare) ?? []), path]);
    }
    return new Map([...claimants].filter(([, paths]) => paths.length > 1));
  },
  /**
   * The title line is left out (`withoutTitleLine`); front matter goes as in the generic profile, but only for a file that does not open with its title line: front matter sits at
   * the very top of a file, so what follows that line is never read as front matter. Callouts and toggles are converted before the schema sees them (`constructs.ts`).
   */
  preprocess: (markdown, ctx) => {
    const body = withoutTitleLine(markdown);
    return convertConstructs(body === markdown ? markdownProfile.preprocess(markdown, ctx) : body, ctx.onConstruct);
  },
  resolveLink: resolveNotionLink,
  idOf,
  csvToMarkdown: csvToMarkdownTable,
};
