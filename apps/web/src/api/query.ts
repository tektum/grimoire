import { type UseMutationOptions, type UseQueryOptions, useMutation, useQuery } from '@tanstack/react-query';

type Init = Readonly<Record<string, unknown>> | undefined;
/** The shape of the typed client's methods that the wrappers call. */
type Caller = (path: never, init?: never) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
export interface ApiLike {
  GET: Caller;
  POST: Caller;
  PUT: Caller;
  PATCH: Caller;
  DELETE: Caller;
}

/** Query keys are `[method, path, params]` (contracts section 5). */
export const queryKey = (method: string, path: string, init: Init): readonly unknown[] => [method, path, init ?? null];

/** Document content is never kept in a query cache (R11.5): the markdown and revision-body routes pass `gcTime: 0`. */
export const NO_CACHE = { gcTime: 0 } as const;

export function useApiQuery<T = unknown>(api: ApiLike, path: string, init?: Init, options?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>) {
  return useQuery<T>({
    ...options,
    queryKey: queryKey('GET', path, init),
    queryFn: async ({ signal }) => {
      // The signal lets React Query cancel the read when nothing uses the query any more.
      const { data, response } = await api.GET(path as never, { ...init, signal } as never);
      if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
      return data as T;
    },
  });
}

export function useApiMutation<T = unknown, V extends Init = Init>(
  api: ApiLike,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  options?: Omit<UseMutationOptions<T, Error, V>, 'mutationFn'>,
) {
  return useMutation<T, Error, V>({
    ...options,
    mutationFn: async (init) => {
      const { data, response } = await api[method](path as never, init as never);
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
      return data as T;
    },
  });
}
