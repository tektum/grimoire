import { decodeSearchCursor, encodeSearchCursor } from '@tektum/grimoire-core/search/cursor';
import { splitSnippet } from '@tektum/grimoire-core/search/snippet';
import type { Database } from '@tektum/grimoire-core/ports/database';
import { SearchTimeoutError, type SearchHit, type SearchRepo } from '@tektum/grimoire-core/ports/search-repo';

/** Thrown by a repository whose task has not been built yet, so a route that reaches it fails loudly instead of answering with nothing. */
export class RepoUnavailableError extends Error {
  constructor(what: string, task: string) {
    super(`${what} is not available yet (${task})`);
    this.name = 'RepoUnavailableError';
  }
}

export interface SearchOptions {
  /** `GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS`: one search may run this long. */
  readonly statementTimeoutMs: number;
}

/** How much of a page `ts_headline` reads: it costs time in proportion to what it reads (66 ms for 1.1 MB, 1.6 ms for 20,000 characters). */
const HEADLINE_WINDOW = 200_000;

/** The query of docs/search.md: the full-text and title branches, the access predicate and the keyset, then only the final rows get a headline. */
const SEARCH = `
  select * from (
    select p.id, p.url_id, p.title, p.collection_id, p.search_partial,
           (extract(epoch from coalesce(p.last_edited_at, p.updated_at)) * 1000000)::bigint as edited_us,
           greatest(ts_rank_cd(p.tsv, q.q),
                    case when length($1::text) >= 3 and (p.title % $1::text or p.title ilike '%' || $8::text || '%')
                         then greatest(similarity(p.title, $1::text), 0.1) * 0.5 else 0 end)::float4 as rank
      from pages p, (select websearch_to_tsquery('simple', $1::text) as q) q
     where (p.tsv @@ q.q or (length($1::text) >= 3 and (p.title % $1::text or p.title ilike '%' || $8::text || '%')))
       and p.deleted_at is null
       and p.tenant_id = $9::text
       and p.collection_id = any($2::uuid[])
       and ($3::uuid is null or p.collection_id = $3)
  ) s
  where ($4::float4 is null or (s.rank, s.edited_us, s.id) < ($4::float4, $5::bigint, $6::uuid))
  order by s.rank desc, s.edited_us desc, s.id desc
  limit $7`;

const HEADLINES = `
  select p.id,
         ts_headline('simple', replace(replace(left(p.text_content, ${String(HEADLINE_WINDOW)}), chr(1), ' '), chr(2), ' '), websearch_to_tsquery('simple', $2::text),
                     'StartSel=' || chr(1) || ',StopSel=' || chr(2) || ',MaxFragments=2,MaxWords=12,MinWords=5') as headline,
         replace(replace(left(p.text_content, 200), chr(1), ' '), chr(2), ' ') as lead
    from pages p
   where p.id = any($1::uuid[]) and p.tenant_id = $3::text`;

interface Row {
  readonly id: string;
  readonly url_id: string;
  readonly title: string;
  readonly collection_id: string;
  readonly search_partial: boolean;
  readonly edited_us: string;
  readonly rank: number;
}

/** PostgreSQL cancels a statement past `statement_timeout` with SQLSTATE 57014; the code may sit on a wrapped cause. */
function isCancelled(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e !== null && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth += 1) {
    if ((e as { code?: unknown }).code === '57014') return true;
  }
  return false;
}

/** The characters `ilike` treats as its own, escaped, so that a title is found by the characters of the query and nothing else. */
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Full-text search of the pages a person may read (R9.7 to R9.11, docs/search.md): one transaction with its own statement timeout and trigram threshold. The
 * query is a bound parameter throughout; nothing the caller sends is put into the statement text.
 */
export function createSearchRepo(db: Database, options: SearchOptions): SearchRepo {
  const timeout = String(Math.trunc(options.statementTimeoutMs)); // `set local` takes no parameter: an integer of ours is inlined
  return {
    async search(request) {
      const key = request.cursor === undefined ? undefined : decodeSearchCursor(request.cursor);
      try {
        return await db.transaction(async (tx) => {
          await tx.query(`set local statement_timeout = ${timeout}`);
          await tx.query(`set local pg_trgm.similarity_threshold = 0.3`);
          const rows = await tx.query<Row>(SEARCH, [
            request.query, [...request.collectionIds], request.collectionId ?? null,
            key?.rank ?? null, key?.editedAt ?? null, key?.id ?? null, request.limit + 1, escapeLike(request.query), request.tenantId,
          ]);
          const page = rows.slice(0, request.limit);
          const texts = page.length === 0 ? [] : await tx.query<{ id: string; headline: string | null; lead: string | null }>(HEADLINES, [page.map((r) => r.id), request.query, request.tenantId]);
          const byId = new Map(texts.map((t) => [t.id, t]));
          const hits: SearchHit[] = page.map((r) => {
            const t = byId.get(r.id);
            return {
              pageId: r.id, urlId: r.url_id, title: r.title, collectionId: r.collection_id, snippet: splitSnippet(t?.headline ?? null, t?.lead ?? ''),
              partial: r.search_partial, updatedAt: Number(r.edited_us) / 1000, rank: r.rank,
            };
          });
          const last = page[page.length - 1];
          return rows.length > request.limit && last !== undefined
            ? { hits, nextCursor: encodeSearchCursor({ rank: last.rank, editedAt: Number(last.edited_us), id: last.id }) }
            : { hits };
        });
      } catch (error) {
        if (isCancelled(error)) throw new SearchTimeoutError();
        throw error;
      }
    },
  };
}
