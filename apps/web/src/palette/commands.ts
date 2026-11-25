import { pagePath } from '../tree/model';

/** What the palette can do besides search: go to a place or make a page. A command has a group, a label and what it does (`run` with the helpers of the screen). */
export interface Command {
  readonly id: string;
  readonly group: 'Pages' | 'Collections' | 'Go to' | 'Actions';
  readonly label: string;
  readonly run: (go: (path: string) => void, newPage: () => void) => void;
}

export interface CommandWorld {
  readonly role: 'admin' | 'member' | 'viewer' | undefined;
  /** The collections the person can see. */
  readonly collections: readonly { readonly id: string; readonly name: string }[];
  /** The pages of the open collection, flat (the tree's list). */
  readonly pages: readonly { readonly id: string; readonly urlId: string; readonly title: string }[];
  /** Whether the person may make a page in the open collection. */
  readonly canMakePage: boolean;
}

const UNTITLED = 'Untitled';

/** Every command the person has now. Admin is offered to administrators only; New page where they may write. */
export function commandsFor(world: CommandWorld): Command[] {
  const commands: Command[] = [];
  for (const page of world.pages) commands.push({ id: `page:${page.id}`, group: 'Pages', label: page.title === '' ? UNTITLED : page.title, run: (go) => go(pagePath(page.title, page.urlId)) });
  for (const collection of world.collections) commands.push({ id: `collection:${collection.id}`, group: 'Collections', label: collection.name, run: (go) => go(`/c/${collection.id}`) });
  commands.push({ id: 'go:search', group: 'Go to', label: 'Search', run: (go) => go('/search') });
  commands.push({ id: 'go:trash', group: 'Go to', label: 'Trash', run: (go) => go('/trash') });
  if (world.role === 'admin') commands.push({ id: 'go:admin', group: 'Go to', label: 'Admin', run: (go) => go('/admin/users') });
  if (world.canMakePage) commands.push({ id: 'action:new-page', group: 'Actions', label: 'New page', run: (_go, newPage) => newPage() });
  return commands;
}

/** How many page commands the palette draws: a few before anything is typed, a screenful while typing. The list is not virtualised, and a collection can have thousands of pages. */
export const PAGES_UNTYPED = 8;
export const PAGES_TYPED = 20;

/** The commands whose label holds every word of `q` (any case); all of them for an empty `q`, except that the pages are cut to the first few (the matching is over all the pages, then cut). */
export function filterCommands(commands: readonly Command[], q: string): Command[] {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const matching = commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  const room = words.length === 0 ? PAGES_UNTYPED : PAGES_TYPED;
  let pages = 0;
  return matching.filter((c) => c.group !== 'Pages' || ++pages <= room);
}
