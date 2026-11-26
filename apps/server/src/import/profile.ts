import type { ImportItemKind } from '@tektum/grimoire-core/ports/import-repo';

/** The longest title a page has, in code points: the engine cuts a longer one (a warning); a profile that leaves a title line out of the body keeps a longer one in it. */
export const MAX_TITLE = 255;

/** An item of the archive a link can point to. */
export interface IndexedItem { readonly itemId: string; readonly path: string; readonly kind: 'page' | 'attachment' }

/**
 * What a profile looks links up in: the items by their canonical archive path (`.` and empty segments dropped, NFC, as `resolveLinkPath` makes its targets) and, for an export that
 * names pages by an id in the file name, by that id.
 */
export interface LinkIndex {
  readonly byPath: ReadonlyMap<string, IndexedItem>;
  readonly byId: ReadonlyMap<string, IndexedItem>;
}

/** A link resolved to an item, with its fragment (never a path: a resolved path is only a lookup key). */
export interface Target { readonly kind: 'page' | 'attachment'; readonly itemId: string; readonly fragment?: string }

/**
 * What differs between the sources of an archive (M7 contracts section 4): how an entry is classified, a page's title and parent, what is cleaned from its Markdown before it is
 * parsed, and how a link is found. The generic `markdown_zip` profile is `markdown-profile.ts`; the rules for a page-tree export with its own naming are a second profile (M7-T06).
 */
export interface ImportProfile {
  readonly source: 'markdown_zip' | 'notion_md_csv';
  /** What an entry is; `lowerPaths` as for `parentPathOf` (a profile whose answer depends on the other entries reads it). */
  classify(entry: { readonly path: string }, lowerPaths?: ReadonlySet<string>): ImportItemKind;
  titleOf(path: string, markdown: string): string;
  /**
   * The path of the folder (or page) this page goes under, or null at the top. `lowerPaths` is every path of the archive, canonical (`.` and empty segments dropped) and lower-cased: a profile whose answer depends on the
   * other entries (a folder with two candidates for its page) reads it; without it the answer is the one for a folder that has no other candidate.
   */
  parentPathOf(path: string, lowerPaths?: ReadonlySet<string>): string | null;
  preprocess(markdown: string, ctx: { readonly path: string }): string;
  resolveLink(url: string, fromPath: string, index: LinkIndex): Target | undefined;
  /**
   * The folder this page file stands for (the page of the folder `dir` is the file the profile names, so the engine attaches the folder's children to it instead of making an empty
   * container page), or undefined when the file is an ordinary page. `lowerPaths` as for `parentPathOf`: a folder with two candidates has one winner.
   */
  folderPathOf(path: string, lowerPaths?: ReadonlySet<string>): string | undefined;
  /**
   * The folders that one page and one database of one name share (`X/` beside `X <id>.md` and `X <id2>_all.csv`), by the folder's key (canonical path, NFC, lower case): the
   * page's and the database's paths. The engine puts a page of such a folder under the database when its title is a row of the table, else under the page (decision 167).
   */
  sharedFoldersOf?(pagePaths: readonly string[], lowerPaths: ReadonlySet<string>): ReadonlyMap<string, { readonly page: string; readonly database: string }>;
  /** The id a name carries, for an export that names its pages by an id (the link index then finds an item by it); a profile without such names has none. */
  idOf?(path: string): string | undefined;
  /** A database export (a CSV) as a Markdown table, or undefined when the table would be over `maxBytes`; only a profile that has such exports provides it. */
  csvToMarkdown?(rows: readonly (readonly string[])[], maxBytes: number): string | undefined;
}
