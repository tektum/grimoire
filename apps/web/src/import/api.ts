import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../auth/session';
import { quietApiOf } from '../editor/attachments/quiet-api';
import type { ApiLike } from '../api/query';
import { queryKey } from '../api/query';
import { storeFetch } from '../api/store';
import { ENDED, type CreatedImport, type ImportItem, type ImportItems, type ImportState } from './types';

/**
 * The API client of the import screens: the session's own, with its notices turned off. The screens tell every refusal and failure once, in their own words (a file that is not a zip, a collection that is
 * full, a read that failed), so the client must not also toast "Something went wrong" beside them. Token, refresh, sign-out and the version header are the session's. A session with no API address (a test
 * with a fake client) uses its client as it is.
 */
export function useQuietApi(): ApiLike {
  const session = useSession();
  return useMemo(() => {
    if (session === null) throw new Error('useQuietApi needs the session of the app');
    return (quietApiOf(session) as ApiLike | undefined) ?? session.api;
  }, [session]);
}

/** An answer the API gave that is not a success: its status and its error code. */
export class ImportError extends Error {
  constructor(
    readonly step: 'create' | 'upload' | 'start' | 'read' | 'cancel' | 'items' | 'source',
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`${step}: ${String(status)}${code === undefined ? '' : ` ${code}`}`);
  }
}

type Reply = { data?: unknown; error?: unknown; response: Response };
const codeOf = (error: unknown): string | undefined => (error as { error?: { code?: string } } | undefined)?.error?.code;
const okOr = (step: ImportError['step'], { data, error, response }: Reply): unknown => {
  if (!response.ok) throw new ImportError(step, response.status, codeOf(error));
  return data;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const STATUSES: readonly unknown[] = ['created', 'uploaded', 'running', 'done', 'failed', 'cancelled'];
const isCreated = (v: unknown): v is CreatedImport => isObject(v) && typeof v.id === 'string' && isObject(v.upload) && v.upload.method === 'PUT' && typeof v.upload.url === 'string' && isObject(v.upload.headers);
const isState = (v: unknown): v is ImportState =>
  isObject(v) && STATUSES.includes(v.status) && isObject(v.counts) && ['pagesTotal', 'pagesDone', 'skipped', 'failed'].every((k) => typeof (v.counts as Record<string, unknown>)[k] === 'number');
const isItems = (v: unknown): v is ImportItems =>
  isObject(v) &&
  Array.isArray(v.items) &&
  v.items.every(
    (i: unknown) =>
      isObject(i) &&
      typeof i.id === 'string' &&
      typeof i.path === 'string' &&
      ['ok', 'skipped', 'failed'].includes(i.status as string) &&
      typeof i.hasSource === 'boolean' &&
      (i.message === null || typeof i.message === 'string'),
  ) &&
  (v.nextCursor === null || typeof v.nextCursor === 'string');
/** The routes are not in the generated client yet, so the answers are not typed for us: what is not shaped as it is used is an error of that step, not a failure later and elsewhere. */
function shaped<T>(step: ImportError['step'], value: unknown, is: (v: unknown) => v is T): T {
  if (!is(value)) throw new ImportError(step, 200, undefined);
  return value;
}

/** Makes the import (R6.39): the zip is not sent yet. */
export async function createImport(api: ApiLike, body: { collectionId: string; fileName: string; size: number }): Promise<CreatedImport> {
  return shaped('create', okOr('create', await api.POST('/v1/imports' as never, { body } as never)), isCreated);
}

/** PUTs the zip where the API said, with the headers it said (they are part of what the signature covers). A network failure is a status 0. */
export async function uploadZip(upload: CreatedImport['upload'], file: Blob, send: typeof fetch = storeFetch): Promise<void> {
  let response: Response;
  try {
    response = await send(upload.url, { method: upload.method, headers: upload.headers, body: file, credentials: 'omit' });
  } catch {
    throw new ImportError('upload', 0, undefined);
  }
  if (!response.ok) throw new ImportError('upload', response.status, undefined);
}

/** Starts the import (R6.40): the API checks the zip first. */
export async function startImport(api: ApiLike, id: string): Promise<void> {
  okOr('start', await api.POST('/v1/imports/{id}/start' as never, { params: { path: { id } } } as never));
}

/** How often a running import is read again. */
export const POLL_MS = 2000;

/** The state of an import (R6.41), read again every two seconds until it has ended. */
export function useImportState(api: ApiLike, id: string | null) {
  return useQuery<ImportState, ImportError>({
    enabled: id !== null,
    retry: false,
    queryKey: queryKey('GET', '/v1/imports/{id}', { params: { path: { id } } }),
    queryFn: async ({ signal }) => shaped('read', okOr('read', await api.GET('/v1/imports/{id}' as never, { params: { path: { id } }, signal } as never)), isState),
    // Not once it has ended, and not while the last read failed: a failure is shown with a way to try again (`refetch`), which goes on polling when it works.
    refetchInterval: (query) => (query.state.status === 'error' || (query.state.data !== undefined && ENDED.includes(query.state.data.status)) ? false : POLL_MS),
  });
}

/** Cancels a running import (R6.40): its pages are moved to the trash. A 409 `not_running` is an import that has ended since the person looked. */
export async function cancelImport(api: ApiLike, id: string): Promise<void> {
  okOr('cancel', await api.POST('/v1/imports/{id}/cancel' as never, { params: { path: { id } } } as never));
}

/** One page of the report of an import (R6.41). */
export async function readItems(api: ApiLike, id: string, cursor: string | undefined): Promise<ImportItems> {
  return shaped('items', okOr('items', await api.GET('/v1/imports/{id}/items' as never, { params: { path: { id }, query: cursor === undefined ? {} : { cursor } } } as never)), isItems);
}

/** The address a failed page's original file can be fetched from, for a short time (R6.41). */
export async function sourceUrl(api: ApiLike, id: string, itemId: string): Promise<string> {
  const answer = okOr('source', await api.GET('/v1/imports/{id}/items/{itemId}/source' as never, { params: { path: { id, itemId } } } as never)) as { url?: unknown };
  if (typeof answer.url !== 'string') throw new ImportError('source', 200, undefined);
  return answer.url;
}

/**
 * The report of an ended import, a page at a time. Held in the component and not in the query cache: it has the names of the person's files and the reasons, which are not kept anywhere
 * but on this screen. `retry` and `more` read the page after the last one that came.
 */
export function useImportReport(api: ApiLike, id: string) {
  const [items, setItems] = useState<readonly ImportItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  // Only the latest read commits: an answer for another import (or for one that was left) that comes last is dropped.
  const latest = useRef(0);
  const load = useCallback(
    async (cursor: string | undefined): Promise<void> => {
      const mine = ++latest.current;
      setPhase('loading');
      try {
        const page = await readItems(api, id, cursor);
        if (mine !== latest.current) return;
        setItems((before) => (cursor === undefined ? page.items : [...before, ...page.items]));
        setNext(page.nextCursor);
        setPhase('ready');
      } catch {
        if (mine === latest.current) setPhase('error');
      }
    },
    [api, id],
  );
  useEffect(() => {
    setItems([]);
    setNext(null);
    void load(undefined);
    return () => {
      latest.current += 1; // the import changed or the screen left: nothing that is on its way is used
    };
  }, [load]);
  return { items, hasMore: next !== null, phase, more: () => void load(next ?? undefined) };
}
