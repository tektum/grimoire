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
