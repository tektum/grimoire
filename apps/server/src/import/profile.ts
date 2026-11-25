import type { ImportItemKind } from '@tektum/grimoire-core/ports/import-repo';

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
 * parsed, and how a link is found. The generic `markdown_zip` profile is `markdown-profile.ts`; the Notion rules are a second profile (M7-T06).
 */
export interface ImportProfile {
  readonly source: 'markdown_zip' | 'notion_md_csv';
  classify(entry: { readonly path: string }): ImportItemKind;
  titleOf(path: string, markdown: string): string;
  /** The path of the folder (or page) this page goes under, or null at the top. */
  parentPathOf(path: string): string | null;
  preprocess(markdown: string, ctx: { readonly path: string }): string;
  resolveLink(url: string, fromPath: string, index: LinkIndex): Target | undefined;
  /** A database export (a CSV) as a Markdown table; only a profile that has such exports provides it. */
  csvToMarkdown?(rows: readonly (readonly string[])[]): string;
}
