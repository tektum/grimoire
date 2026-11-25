import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSession } from '../auth/session';
import { quietApiOf } from '../editor/attachments/quiet-api';
import type { ApiLike } from '../api/query';
import { queryKey } from '../api/query';
import { storeFetch } from '../api/store';
import { ENDED, type CreatedImport, type ImportState } from './types';

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
    readonly step: 'create' | 'upload' | 'start' | 'read',
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

/** Makes the import (R6.39): the zip is not sent yet. */
export async function createImport(api: ApiLike, body: { collectionId: string; fileName: string; size: number }): Promise<CreatedImport> {
  return okOr('create', await api.POST('/v1/imports' as never, { body } as never)) as CreatedImport;
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
    queryFn: async ({ signal }) => okOr('read', await api.GET('/v1/imports/{id}' as never, { params: { path: { id } }, signal } as never)) as ImportState,
    // Not once it has ended, and not while the last read failed: a failure is shown with a way to try again (`refetch`), which goes on polling when it works.
    refetchInterval: (query) => (query.state.status === 'error' || (query.state.data !== undefined && ENDED.includes(query.state.data.status)) ? false : POLL_MS),
  });
}
