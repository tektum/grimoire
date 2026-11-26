/** What `POST /v1/imports` answers (R6.39): the import, and where and how to PUT the zip. */
export interface CreatedImport {
  readonly id: string;
  readonly upload: { readonly method: 'PUT'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly expiresAt: string };
}

/** `imports.status` (M7 import pipeline): created, then uploaded, then running, then one of the three ends. */
export type ImportStatus = 'created' | 'uploaded' | 'running' | 'done' | 'failed' | 'cancelled';

/** What the import did to a kind of content of the pages it wrote (`GET /v1/imports/{id}`, `report.constructs`): converted into Grimoire's own form, dropped, or kept as it was written. */
export type ConstructKind = 'callout' | 'toggle' | 'page_mention' | 'database_table' | 'front_matter' | 'icon_cover' | 'database_row' | 'unresolved_link' | 'raw_html';
export type ConstructFate = 'converted' | 'dropped' | 'kept';

/** A page that holds a construct: its item, its path in the zip (plain text, at most 300 characters) and its address id (`/p/<urlId>`), null for a row that was left out. */
export interface ReportPage {
  readonly itemId: string;
  readonly path: string;
  readonly urlId: string | null;
}

/** One kind of content: how often it occurred in the pages written, and the first pages (at most 100) that hold it; `capped` when more pages hold it than are named. */
export interface ConstructLine {
  readonly kind: ConstructKind;
  readonly fate: ConstructFate;
  readonly count: number;
  readonly pages: readonly ReportPage[];
  readonly capped: boolean;
}

/** What the import did to the constructs of the pages it wrote, and the pages that still hold HTML (with the number of fragments), so that someone can clean them up. */
export interface ImportConstructReport {
  readonly constructs: readonly ConstructLine[];
  readonly rawHtmlPages: readonly (ReportPage & { readonly fragments: number })[];
  readonly rawHtmlCapped: boolean;
}

/** What `GET /v1/imports/{id}` answers (R6.41). */
export interface ImportState {
  readonly status: ImportStatus;
  readonly counts: { readonly pagesTotal: number; readonly pagesDone: number; readonly attachments: number; readonly skipped: number; readonly failed: number };
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** A code, not text, for a `failed` import. */
  readonly error: string | null;
  /** Absent from a server that does not say; empty before anything is written. */
  readonly report?: ImportConstructReport;
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
