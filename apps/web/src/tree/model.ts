import type { components } from '@tektum/grimoire-api-client';

/** A page as `GET /v1/collections/{id}/tree` lists it: flat, with its parent and its sort key among siblings. The shape is the generated client's. */
export type FlatPage = Readonly<components['schemas']['CollectionTreePage']>;

/** A node as `react-arborist` reads it: `name` is the shown title, `children` is absent for a leaf. */
export interface TreeItem {
  readonly id: string;
  readonly urlId: string;
  /** The title as stored (empty for a page nobody has named): the link's slug is made from it, not from the shown `name`. */
  readonly title: string;
  readonly name: string;
  readonly icon: string | null;
  readonly children?: TreeItem[];
}

const UNTITLED = 'Untitled';

/** Positions are sort keys to compare as bytes (they are ASCII): plain code-unit order, never a locale order. */
const sortKey = (p: FlatPage): string => `${p.position}\0${p.id}`; // the id breaks a tie: unique, so two keys are never equal
const byPosition = (a: FlatPage, b: FlatPage): number => (sortKey(a) < sortKey(b) ? -1 : 1);

/**
 * The nested tree of a flat list. Siblings are ordered by position. A page whose parent is not in the list goes to the top level, so nothing is lost;
 * the pages of a parent cycle (the server never answers one) are left out rather than looped on.
 */
export function buildTree(pages: readonly FlatPage[]): TreeItem[] {
  const ids = new Set(pages.map((p) => p.id));
  const children = new Map<string | null, FlatPage[]>();
  for (const p of [...pages].sort(byPosition)) {
    const parent = p.parentId !== null && ids.has(p.parentId) ? p.parentId : null;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [p]);
    else list.push(p);
  }
  const make = (p: FlatPage): TreeItem => {
    const below = children.get(p.id);
    return { id: p.id, urlId: p.urlId, title: p.title, name: p.title === '' ? UNTITLED : p.title, icon: p.icon, ...(below === undefined ? {} : { children: below.map(make) }) };
  };
  return (children.get(null) ?? []).map(make);
}

/** A readable, ASCII-only slug of a title for a page link: letters and digits, single dashes, at most 60 characters; `page` when nothing is left. */
export function slugOf(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug === '' ? 'page' : slug;
}

/** The link to a page: `/p/<title-slug>-<urlId>`; the route reads the text after the last dash as the `urlId`. */
export const pagePath = (title: string, urlId: string): string => `/p/${slugOf(title)}-${urlId}`;
