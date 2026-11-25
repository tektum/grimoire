/** What `POST /v1/imports` answers (R6.39): the import, and where and how to PUT the zip. */
export interface CreatedImport {
  readonly id: string;
  readonly upload: { readonly method: 'PUT'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly expiresAt: string };
}

/** `imports.status` (M7 import pipeline): created, then uploaded, then running, then one of the three ends. */
export type ImportStatus = 'created' | 'uploaded' | 'running' | 'done' | 'failed' | 'cancelled';

/** What `GET /v1/imports/{id}` answers (R6.41). */
export interface ImportState {
  readonly status: ImportStatus;
  readonly counts: { readonly pagesTotal: number; readonly pagesDone: number; readonly attachments: number; readonly skipped: number; readonly failed: number };
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** A code, not text, for a `failed` import. */
  readonly error: string | null;
}

/** The statuses after which nothing changes: the polling stops. */
export const ENDED: readonly ImportStatus[] = ['done', 'failed', 'cancelled'];

/** One file of the zip as the report says it (R6.41, `GET /v1/imports/{id}/items`). `message` is plain text of at most 300 characters. */
export interface ImportItem {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly pageId: string | null;
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly message: string | null;
  readonly markdownBytes: number | null;
  readonly stateBytes: number | null;
  /** Whether the original file of a failed page can be downloaded. */
  readonly hasSource: boolean;
  /** Pictures from the web of the page that were not copied: a count for each reason code, never an address. Absent from a server that does not say. */
  readonly remoteImageFailures?: Readonly<Record<string, number>>;
}

/** One page of the report. */
export interface ImportItems {
  readonly items: readonly ImportItem[];
  readonly nextCursor: string | null;
}
