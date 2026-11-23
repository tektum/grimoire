/** Idempotency keys (R6.7): one durable row per (user, key) with the hash of the request that first used it. */

/** The stored answer of a request that finished. `body` is the parsed JSON of the response, or null when it had none. */
export interface StoredResponse { readonly status: number; readonly body: unknown }

export type ClaimResult =
  /** The caller is the first user of the key and must run the request, then `complete` or `release`. */
  | { readonly kind: 'claimed' }
  /** The same key and the same request finished before: answer with this. */
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  /** The key was used with another request, or the first request is still running. */
  | { readonly kind: 'conflict' };

export interface IdempotencyStore {
  /** Atomically claims `(userId, key)` for a request whose method, path and body hash to `requestHash` (lower-case hex). */
  claim(userId: string, key: string, requestHash: string): Promise<ClaimResult>;
  /** Stores the answer of the request that holds the claim; later identical requests replay it. */
  complete(userId: string, key: string, response: StoredResponse): Promise<void>;
  /** Frees a claim whose request did not produce an answer worth replaying, so the key can be used again. */
  release(userId: string, key: string): Promise<void>;
  /** Deletes the rows created before `cutoffMs` (epoch milliseconds); returns how many. */
  deleteCreatedBefore(cutoffMs: number): Promise<number>;
}
