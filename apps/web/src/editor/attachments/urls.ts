/** A link the file store signed: where to load the file from, and when the link stops working (epoch milliseconds). */
export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: number;
}

/** Asks the server for the signed links of these ids (at most {@link MAX_BATCH}); an id the person cannot read is left out of the answer. */
export type FetchUrls = (ids: string[]) => Promise<ReadonlyMap<string, SignedUrl>>;

export interface UrlBatcher {
  /** The link of an attachment: the one held, or a new one when none is held or it is about to expire. */
  url(id: string): Promise<SignedUrl>;
  /** A new link, whether or not the held one has expired (the image failed to load with it). */
  refresh(id: string): Promise<SignedUrl>;
}

/** The most ids one request carries (`POST /v1/attachments/urls`). */
export const MAX_BATCH = 50;
/** A link that expires within this long is not handed out: it could stop working before the image has loaded. */
export const EXPIRY_MARGIN_MS = 30_000;

interface Waiting {
  readonly resolve: (link: SignedUrl) => void;
  readonly reject: (error: Error) => void;
}

/** Collects the ids wanted in one turn of the event loop into requests of at most {@link MAX_BATCH} ids, and keeps each answer until it is about to expire. */
export function createUrlBatcher(fetchUrls: FetchUrls, now: () => number = Date.now): UrlBatcher {
  const held = new Map<string, SignedUrl>();
  const inflight = new Map<string, Promise<SignedUrl>>();
  const waiting = new Map<string, Waiting>();
  let scheduled = false;

  const flush = async (): Promise<void> => {
    scheduled = false;
    const ids = [...waiting.keys()];
    const taken = new Map(waiting);
    waiting.clear();
    for (let from = 0; from < ids.length; from += MAX_BATCH) {
      const chunk = ids.slice(from, from + MAX_BATCH);
      // The chunks go out together: nothing waits for another chunk's answer.
      void fetchUrls(chunk).then(
        (answer) => {
          for (const id of chunk) {
            const link = answer.get(id);
            if (link === undefined) taken.get(id)!.reject(new Error(`no link for attachment ${id}`));
            else {
              // A link that is already inside its margin is handed out (nothing better is to be had, and a clock that is ahead of the server's must not stop the image) but not kept.
              if (link.expiresAt - EXPIRY_MARGIN_MS > now()) held.set(id, link);
              taken.get(id)!.resolve(link);
            }
          }
        },
        (error: unknown) => {
          for (const id of chunk) taken.get(id)!.reject(error instanceof Error ? error : new Error('could not get the link'));
        },
      );
    }
  };

  const request = (id: string): Promise<SignedUrl> => {
    const existing = inflight.get(id);
    if (existing !== undefined) return existing;
    const promise = new Promise<SignedUrl>((resolve, reject) => waiting.set(id, { resolve, reject }));
    inflight.set(id, promise);
    const forget = (): void => void inflight.delete(id);
    promise.then(forget, forget);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => void flush());
    }
    return promise;
  };

  return {
    url(id) {
      const link = held.get(id);
      if (link !== undefined && link.expiresAt - EXPIRY_MARGIN_MS > now()) return Promise.resolve(link);
      return request(id);
    },
    refresh(id) {
      held.delete(id);
      return request(id);
    },
  };
}
