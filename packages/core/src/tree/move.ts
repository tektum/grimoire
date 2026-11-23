/** A page forest as the move rules need it: who is whose parent, and who are a page's children. */
export interface Forest {
  parentOf(id: string): string | null | undefined;
  childrenOf(id: string): readonly string[];
}

/** A forest over rows of `{ id, parentId }`. */
export function forestOf(rows: readonly { readonly id: string; readonly parentId: string | null }[]): Forest {
  const parents = new Map(rows.map((r) => [r.id, r.parentId] as const));
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentId !== null) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r.id]);
  }
  return { parentOf: (id) => parents.get(id), childrenOf: (id) => children.get(id) ?? [] };
}

/** The level of a page: a top-level page is 1. A loop in the data stops the count instead of looping forever. */
export function depthOf(forest: Forest, id: string): number {
  const seen = new Set<string>();
  let depth = 0;
  for (let at: string | null | undefined = id; at !== null && at !== undefined && !seen.has(at); at = forest.parentOf(at)) {
    seen.add(at);
    depth += 1;
  }
  return depth;
}

/** The number of levels in the subtree under `id`, the page itself included: a leaf is 1. */
export function heightOf(forest: Forest, id: string): number {
  let height = 0;
  let level: readonly string[] = [id];
  const seen = new Set<string>();
  while (level.length > 0) {
    height += 1;
    const next: string[] = [];
    for (const at of level) {
      if (seen.has(at)) continue;
      seen.add(at);
      next.push(...forest.childrenOf(at));
    }
    level = next;
  }
  return height;
}

/** True when `id` is `ancestor` itself or lies inside its subtree: the places `ancestor` must never be moved to. */
export function isSelfOrDescendant(forest: Forest, ancestor: string, id: string): boolean {
  const seen = new Set<string>();
  for (let at: string | null | undefined = id; at !== null && at !== undefined && !seen.has(at); at = forest.parentOf(at)) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

export type MoveCheck = 'ok' | 'would-create-cycle' | 'too-deep';

/** R5.7 and the depth limit for moving `id` under `newParent` (null: top level). Pure: the repository applies the same rules in SQL. */
export function checkMove(forest: Forest, move: { readonly id: string; readonly newParent: string | null; readonly maxDepth: number }): MoveCheck {
  if (move.newParent !== null && isSelfOrDescendant(forest, move.id, move.newParent)) return 'would-create-cycle';
  const parentDepth = move.newParent === null ? 0 : depthOf(forest, move.newParent);
  return parentDepth + heightOf(forest, move.id) > move.maxDepth ? 'too-deep' : 'ok';
}
