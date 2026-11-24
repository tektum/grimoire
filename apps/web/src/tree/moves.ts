import { buildTree, type FlatPage, type TreeItem } from './model';

/** The ids of every page below `id`, at any depth (not `id` itself). */
export function descendantsOf(pages: readonly FlatPage[], id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const page of pages) {
      if (page.parentId === next && !found.has(page.id)) {
        found.add(page.id);
        queue.push(page.id);
      }
    }
  }
  return found;
}

/** A move as the API takes it: under `parentId` (null for the top level), after the sibling `afterId`, before the sibling `beforeId`, or last when neither is set. */
export interface Placement {
  readonly parentId: string | null;
  readonly afterId: string | null;
  readonly beforeId: string | null;
}

const idsOf = (items: readonly TreeItem[] | undefined): string[] => (items ?? []).map((i) => i.id);

function siblingsOf(pages: readonly FlatPage[], parentId: string | null): string[] {
  if (parentId === null) return idsOf(buildTree(pages));
  const find = (items: readonly TreeItem[]): TreeItem | undefined => {
    for (const item of items) {
      if (item.id === parentId) return item;
      const inside = item.children === undefined ? undefined : find(item.children);
      if (inside !== undefined) return inside;
    }
    return undefined;
  };
  return idsOf(find(buildTree(pages))?.children);
}

/**
 * Where a drop puts the dragged page, from the parent and the index the tree reports (the index counts the dragged page when it stays in the same list):
 * after the sibling above the drop place, before the first sibling when the drop place is above it, or last. `'cycle'`: into itself or below itself.
 */
export function planDrop(pages: readonly FlatPage[], dragId: string, parentId: string | null, index: number): Placement | 'cycle' {
  if (parentId !== null && (parentId === dragId || descendantsOf(pages, dragId).has(parentId))) return 'cycle';
  const all = siblingsOf(pages, parentId);
  const before = all.indexOf(dragId);
  const without = all.filter((id) => id !== dragId);
  const at = before !== -1 && before < index ? index - 1 : index;
  if (without.length === 0 || at >= without.length) return { parentId, afterId: null, beforeId: null };
  if (at <= 0) return { parentId, afterId: null, beforeId: without[0] ?? null };
  return { parentId, afterId: without[at - 1] ?? null, beforeId: null };
}

export interface MoveTarget {
  readonly parentId: string | null;
  readonly label: string;
  readonly depth: number;
}

/** The choices of the "Move to…" dialog: the top level, then every page in tree order with its depth, without the page and what is below it. */
export function moveTargets(pages: readonly FlatPage[], id: string): MoveTarget[] {
  const out: MoveTarget[] = [{ parentId: null, label: 'Top level', depth: 0 }];
  const walk = (items: readonly TreeItem[], depth: number): void => {
    for (const item of items) {
      if (item.id === id) continue;
      out.push({ parentId: item.id, label: item.name, depth });
      if (item.children !== undefined) walk(item.children, depth + 1);
    }
  };
  walk(buildTree(pages), 0);
  return out;
}

export const applyCreate = (pages: readonly FlatPage[], page: FlatPage): FlatPage[] => [...pages, page];
export const applyRename = (pages: readonly FlatPage[], id: string, title: string): FlatPage[] => pages.map((p) => (p.id === id ? { ...p, title } : p));
export function applyDelete(pages: readonly FlatPage[], id: string): FlatPage[] {
  const gone = descendantsOf(pages, id);
  return pages.filter((p) => p.id !== id && !gone.has(p.id));
}

/**
 * The list as it will be after a move, for showing it before the server has answered: the page gets a sort key that fits its place (just after the
 * sibling, just before the one it goes before, or after all of them). The next read of the tree replaces these keys with the server's.
 */
export function applyMove(pages: readonly FlatPage[], id: string, to: Placement): FlatPage[] {
  const siblings = pages.filter((p) => p.parentId === to.parentId && p.id !== id).sort((a, b) => (a.position < b.position ? -1 : 1));
  let position = 'p';
  if (to.beforeId !== null) {
    const at = siblings.findIndex((p) => p.id === to.beforeId);
    const previous = siblings[at - 1];
    position = previous === undefined ? ' ' : `${previous.position}~`; // nothing before it: a key that sorts first
  } else {
    const anchor = to.afterId === null ? siblings[siblings.length - 1] : siblings.find((p) => p.id === to.afterId);
    if (anchor !== undefined) position = `${anchor.position}~`;
  }
  return pages.map((p) => (p.id === id ? { ...p, parentId: to.parentId, position } : p));
}
