import { pagePath } from '../tree/model';
import type { RecentPage } from '../storage/recent';

/** What the palette can do besides search: go to a place or make a page. A command has a group, a label and what it does (`run` with the helpers of the screen). */
export interface Command {
  readonly id: string;
  readonly group: 'Recent' | 'Pages' | 'Collections' | 'Go to' | 'Actions';
  readonly label: string;
  /** What the row says beside the label, quietly: the parent page or the collection of a page. */
  readonly path?: string;
  readonly run: (go: (path: string) => void, newPage: () => void) => void;
}

export interface CommandWorld {
  readonly role: 'admin' | 'member' | 'viewer' | undefined;
  /** The collections the person can see. */
  readonly collections: readonly { readonly id: string; readonly name: string }[];
  /** The pages of the open collection, flat (the tree's list). */
  readonly pages: readonly { readonly id: string; readonly urlId: string; readonly title: string; readonly parentId?: string | null }[];
  /** The name of the open collection: the path of a page at its top. */
  readonly collectionName?: string | undefined;
  /** The pages this person opened last, newest first (local to this browser). */
  readonly recent?: readonly RecentPage[] | undefined;
  /** Whether the person may make a page in the open collection. */
  readonly canMakePage: boolean;
}

const UNTITLED = 'Untitled';

/** Every command the person has now. Admin is offered to administrators only; New page where they may write. */
export function commandsFor(world: CommandWorld): Command[] {
  const commands: Command[] = [];
  for (const page of world.recent ?? []) commands.push({ id: `recent:${page.id}`, group: 'Recent', label: page.title === '' ? UNTITLED : page.title, path: page.path, run: (go) => go(pagePath(page.title, page.urlId)) });
  const titleOf = new Map(world.pages.map((p) => [p.id, p.title === '' ? UNTITLED : p.title]));
  for (const page of world.pages) {
    const parent = page.parentId === undefined || page.parentId === null ? undefined : titleOf.get(page.parentId);
    commands.push({ id: `page:${page.id}`, group: 'Pages', label: page.title === '' ? UNTITLED : page.title, path: parent ?? world.collectionName ?? '', run: (go) => go(pagePath(page.title, page.urlId)) });
  }
  for (const collection of world.collections) commands.push({ id: `collection:${collection.id}`, group: 'Collections', label: collection.name, run: (go) => go(`/c/${collection.id}`) });
  commands.push({ id: 'go:search', group: 'Go to', label: 'Search', run: (go) => go('/search') });
  commands.push({ id: 'go:trash', group: 'Go to', label: 'Trash', run: (go) => go('/trash') });
  if (world.role === 'admin') commands.push({ id: 'go:admin', group: 'Go to', label: 'Admin', run: (go) => go('/admin/users') });
  if (world.role === 'admin') commands.push({ id: 'action:new-collection', group: 'Actions', label: 'New collection', run: (go) => go('/collections/new') });
  if (world.canMakePage) commands.push({ id: 'action:new-page', group: 'Actions', label: 'New page', run: (_go, newPage) => newPage() });
  return commands;
}

/** How many page commands the palette draws: the best few, typed or not (the search screen has the rest). The list is not virtualised, and a collection can have thousands of pages. */
export const PAGES_UNTYPED = 5;
export const PAGES_TYPED = 5;

/** The commands whose label holds every word of `q` (any case); all of them for an empty `q`, except that the pages are cut to the first few (the matching is over all the pages, then cut). */
export function filterCommands(commands: readonly Command[], q: string): Command[] {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  // "Recent" is what an empty query offers: a typed query looks in the pages, not in what was opened.
  const matching = commands.filter((c) => (c.group !== 'Recent' || words.length === 0) && words.every((w) => c.label.toLowerCase().includes(w)));
  const room = words.length === 0 ? PAGES_UNTYPED : PAGES_TYPED;
  let pages = 0;
  return matching.filter((c) => c.group !== 'Pages' || ++pages <= room);
}
