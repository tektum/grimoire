import type { Embedder } from '../ports/embedder.js';
import type { EmbeddingStore } from '../ports/embedding-store.js';
import type { SearchHit, SearchRepo, SearchRequest } from '../ports/search-repo.js';
import { modelKey } from '../semantic/model-key.js';
import { decodeHybridCursor, encodeHybridCursor } from './cursor.js';
import { bestChunkPerPage, fuse, limitMeaningOnly, MEANING_ONLY_MAX, pageOf, passageOf, snippetOfPassage, type Candidate } from './hybrid.js';

/** What the semantic part of a search needs: the model, the vectors and the settings (`Config.semantic`) it reads. Without it the answer is full text alone. */
export interface SemanticSearch {
  readonly embedder: Embedder;
  readonly store: EmbeddingStore;
  readonly settings: { readonly enabled: boolean; readonly queryTimeoutMs: number; readonly minSimilarity: number; readonly candidates: number };
}

export interface HybridDeps {
  readonly fullText: SearchRepo;
  readonly semantic?: SemanticSearch;
  /** Only the one event it raises: a debug line with the reason and never the text of the search. The server's event log and a core `Logger` both fit. */
  readonly log: { debug(event: 'search.semantic_fallback', fields: { reason: string }): void };
}

/** A result: a page of the full-text search, or one found only by meaning (its snippet is the start of the passage, with no ranges). */
export interface HybridHit extends SearchHit {
  /** The best chunk of the page, when it came from the semantic list (a page found by meaning, alone or with words). */
  readonly matchedPassage?: { readonly text: string };
}

export interface HybridPage {
  readonly hits: readonly HybridHit[];
  /** True when the semantic search answered (its list may be empty); false when the answer is the full-text search alone. */
  readonly semantic: boolean;
  readonly nextCursor?: string;
}

/** A search that began in the hybrid order cannot go on without the semantic part: its cursor is a place in that order. The caller says "try again". */
export class HybridContinuationUnavailable extends Error {
  constructor() {
    super('the semantic search is not available to continue this answer');
    this.name = 'HybridContinuationUnavailable';
  }
}

type FallbackReason = 'off' | 'not-ready' | 'embed-failed' | 'statement-failed';

/**
 * `GET /v1/search` (contracts section 15.5): the full-text list and the semantic list of pages, fused by rank, with at most `MEANING_ONLY_MAX` pages found only by meaning. The semantic part never
 * fails the answer: when it is off, the model is not ready, the query is not embedded in time or the statement throws, the answer is the full-text search alone with `semantic: false` (and a debug
 * line, with no text of the search). Only a request that carries the cursor of a hybrid answer needs it, and says so.
 */
export async function hybridSearch(deps: HybridDeps, request: SearchRequest): Promise<HybridPage> {
  const key = request.cursor === undefined ? undefined : decodeHybridCursor(request.cursor); // a cursor of the other kind is the full-text search's: it continues there
  if (request.cursor !== undefined && key === undefined) return { ...(await deps.fullText.search(request)), semantic: false };

  const semantic = deps.semantic;
  if (semantic === undefined || !semantic.settings.enabled) return fullTextOnly(deps, request, key, 'off');

  // The two lists are asked for at once: the words (the top `candidates` pages, whatever the cursor says) and the meaning.
  const candidates = semantic.settings.candidates;
  const top: SearchRequest = {
    tenantId: request.tenantId,
    collectionIds: request.collectionIds,
    query: request.query,
    limit: candidates,
    ...(request.collectionId === undefined ? {} : { collectionId: request.collectionId }),
  };
  const [fullText, meaning] = await Promise.all([deps.fullText.search(top), semanticList(semantic, request)]);
  if ('fallback' in meaning) return fullTextOnly(deps, request, key, meaning.fallback);

  const ftHits = new Map(fullText.hits.map((h) => [h.pageId, h]));
  const chunkOf = new Map(meaning.chunks.map((c) => [c.pageId, c]));
  const fused = limitMeaningOnly(
    fuse(
      fullText.hits.map<Candidate>((h) => ({ id: h.pageId, editedAt: h.updatedAt * 1000 })),
      meaning.chunks.map<Candidate>((c) => ({ id: c.pageId, editedAt: c.editedAt })),
    ),
    MEANING_ONLY_MAX,
  );
  const page = pageOf(fused, key === undefined ? undefined : { score: key.rank, editedAt: key.editedAt, id: key.id }, request.limit);
  const hits = page.rows.map<HybridHit>((row) => {
    const words = ftHits.get(row.id);
    const chunk = chunkOf.get(row.id);
    const passage = chunk === undefined ? '' : passageOf(chunk.text, 0, chunk.text.length);
    const matchedPassage = passage === '' ? {} : { matchedPassage: { text: passage } };
    if (words !== undefined) return { ...words, rank: row.score, ...matchedPassage };
    // Found only by meaning (a row of the fused list is in one list at least): the page's own row came with its chunk, and its snippet is the start of the passage.
    const c = chunk as NonNullable<typeof chunk>;
    return { pageId: c.pageId, urlId: c.urlId, title: c.title, collectionId: c.collectionId, snippet: snippetOfPassage(passage), partial: false, updatedAt: c.editedAt / 1000, rank: row.score, ...matchedPassage };
  });
  const last = page.rows.at(-1);
  return { hits, semantic: true, ...(page.more && last !== undefined ? { nextCursor: encodeHybridCursor({ rank: last.score, editedAt: last.editedAt, id: last.id }) } : {}) };
}

/** The answer of the full-text search alone, for the cursor it issued: asked for again, with the request as it came, so it is the same page it always was. A hybrid cursor has no place here. */
async function fullTextOnly(deps: HybridDeps, request: SearchRequest, key: unknown, reason: FallbackReason): Promise<HybridPage> {
  if (key !== undefined) throw new HybridContinuationUnavailable();
  deps.log.debug('search.semantic_fallback', { reason });
  return { ...(await deps.fullText.search(request)), semantic: false };
}

/** The best chunk of each page the person may read, nearest first, or why there is none: this never throws. */
async function semanticList(s: SemanticSearch, request: SearchRequest) {
  if (s.embedder.status() !== 'ready') return { fallback: 'not-ready' as FallbackReason };
  try {
    const query = await s.embedder.embedQuery(request.query, { timeoutMs: s.settings.queryTimeoutMs });
    if (!query.ok) return { fallback: 'embed-failed' as FallbackReason };
    const hits = await s.store.search(request.tenantId, query.vectors[0] as Float32Array, {
      model: modelKey(s.embedder.model),
      collectionIds: request.collectionIds,
      ...(request.collectionId === undefined ? {} : { collectionId: request.collectionId }),
      limit: s.settings.candidates,
      minSimilarity: s.settings.minSimilarity,
    });
    return { chunks: bestChunkPerPage(hits, s.settings.candidates) };
  } catch {
    return { fallback: 'statement-failed' as FallbackReason };
  }
}
