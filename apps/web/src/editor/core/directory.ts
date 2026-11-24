import type { ApiLike } from '../../api/query';

/** What a cursor says for a person the directory does not know (or cannot be asked about). */
export const UNKNOWN_NAME = 'Someone';
const MAX_IDS_PER_REQUEST = 50;
const BATCH_MS = 30;
const RETRY_AFTER_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Directory {
  /** The name for an id: the directory's, or "Someone" until it is known (and for an id it does not know). */
  nameOf(id: string): string;
  /** Asks for the names of these ids, in batches; ids already known or asked for are not asked again. */
  request(ids: Iterable<string>): void;
  /** Called when names arrive. */
  subscribe(listener: () => void): () => void;
}

export interface DirectoryOptions {
  readonly fetchNames: (ids: string[]) => Promise<readonly { id: string; name: string }[]>;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly now?: () => number;
}

export function createDirectory(options: DirectoryOptions): Directory {
  const schedule = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const now = options.now ?? (() => Date.now());
  const names = new Map<string, string>(); // for the session of the app
  const asked = new Set<string>();
  const failedAt = new Map<string, number>();
  const queue = new Set<string>();
  const listeners = new Set<() => void>();
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    const ids = [...queue];
    queue.clear();
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
      const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
      for (const id of chunk) asked.add(id);
      options.fetchNames(chunk).then(
        (items) => {
          const found = new Map(items.map((item) => [item.id.toLowerCase(), item.name]));
          for (const id of chunk) names.set(id, found.get(id.toLowerCase()) ?? UNKNOWN_NAME);
          listeners.forEach((listener) => listener());
        },
        () => {
          // Not remembered as unknown: it is asked again, but not before a pause (the lookup has a rate limit).
          for (const id of chunk) {
            asked.delete(id);
            failedAt.set(id, now());
          }
        },
      );
    }
  };

  return {
    nameOf: (id) => names.get(id) ?? UNKNOWN_NAME,
    request(ids) {
      for (const id of ids) {
        if (names.has(id) || asked.has(id) || queue.has(id)) continue;
        if (!UUID.test(id)) {
          names.set(id, UNKNOWN_NAME); // not an id the directory could know: no request for it
          continue;
        }
        const failed = failedAt.get(id);
        if (failed !== undefined && now() - failed < RETRY_AFTER_MS) continue;
        queue.add(id);
      }
      if (queue.size > 0 && !scheduled) {
        scheduled = true;
        schedule(flush, BATCH_MS);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

const perSession = new WeakMap<object, Directory>();
/** The directory of one signed-in session (one API client): names are fetched once for as long as it lives. */
export function sessionDirectory(api: ApiLike): Directory {
  let directory = perSession.get(api);
  if (directory === undefined) {
    directory = createDirectory({
      fetchNames: async (ids) => {
        const { data, response } = await api.POST('/v1/users/names' as never, { body: { ids } } as never);
        if (!response.ok) throw new Error(`POST /v1/users/names: ${response.status}`);
        return (data as { items: { id: string; name: string }[] }).items;
      },
    });
    perSession.set(api, directory);
  }
  return directory;
}
