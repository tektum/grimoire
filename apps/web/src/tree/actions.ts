import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ApiLike } from '../api/query';
import type { FlatPage } from './model';
import { applyCreate, applyDelete, applyMove, applyRename, type Placement } from './moves';
import { treeKey } from './useTree';

export type Outcome<T = unknown> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly status: number; readonly code: string | undefined };

type Result = Promise<{ data?: unknown; error?: unknown; response: Response }>;

/** One API call as an outcome the caller can match: the data on success, the status and the error code otherwise (the wrapper already showed the notice). */
async function run<T>(call: () => Result): Promise<Outcome<T>> {
  const { data, error, response } = await call();
  if (response.ok) return { ok: true, data: data as T };
  return { ok: false, status: response.status, code: (error as { error?: { code?: string } } | undefined)?.error?.code };
}

/** The request body of a move: exactly one of `afterId` and `beforeId` at most (the API refuses both); neither means last. */
const moveBody = (to: Placement) => ({ parentId: to.parentId, ...(to.beforeId !== null ? { beforeId: to.beforeId } : { afterId: to.afterId }) });

export interface TreeActions {
  /** A new, untitled page under `parentId` (null for the top level), last among its siblings. */
  create(parentId: string | null): Promise<Outcome>;
  rename(id: string, title: string): Promise<Outcome>;
  /** Moves a page: under `to.parentId`, after the sibling `to.afterId`, before `to.beforeId`, or last when neither is set. */
  move(id: string, to: Placement): Promise<Outcome>;
  remove(id: string): Promise<Outcome>;
}

/**
 * The changes a person makes in the tree. Each one is shown at once in the cached list (a move and a delete before the server has answered, a create
 * after it), and the tree is read again whatever the answer was, so a refusal (a 409 that says the tree changed) leaves the screen as the server has it.
 */
export function useTreeActions(api: ApiLike, collectionId: string): TreeActions {
  const client = useQueryClient();
  return useMemo(() => {
    const key = treeKey(collectionId);
    const local = (change: (pages: readonly FlatPage[]) => FlatPage[]): void => {
      client.setQueryData<readonly FlatPage[]>(key, (pages) => (pages === undefined ? pages : change(pages)));
    };
    const settle = async <T,>(call: () => Result, onOk?: (data: T) => void, before?: () => void): Promise<Outcome> => {
      before?.();
      const outcome = await run<T>(call);
      if (outcome.ok) onOk?.(outcome.data);
      await client.invalidateQueries({ queryKey: key });
      return outcome;
    };
    return {
      create: (parentId) =>
        settle<FlatPage>(
          () => api.POST('/v1/pages' as never, { body: { collectionId, parentId } } as never),
          (page) => { local((pages) => applyCreate(pages, page)); },
        ),
      rename: (id, title) =>
        settle(() => api.PATCH('/v1/pages/{id}' as never, { params: { path: { id } }, body: { title } } as never), undefined, () => { local((pages) => applyRename(pages, id, title)); }),
      move: (id, to) =>
        settle(
          () => api.POST('/v1/pages/{id}/move' as never, { params: { path: { id } }, body: moveBody(to) } as never),
          undefined,
          () => { local((pages) => applyMove(pages, id, to)); },
        ),
      remove: (id) => settle(() => api.DELETE('/v1/pages/{id}' as never, { params: { path: { id } } } as never), undefined, () => { local((pages) => applyDelete(pages, id)); }),
    };
  }, [api, client, collectionId]);
}
