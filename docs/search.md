# Search

`GET /v1/search?q=...` finds pages by their title and their text, among the pages the caller may read. Full-text and title search only; the semantic search of milestone 7 extends the same route.

## What it takes and gives

| Parameter | Rule |
|---|---|
| `q` | 1 to 200 characters after trimming. Anything else is 422 `invalid`. It is passed to PostgreSQL as a bound parameter of `websearch_to_tsquery`, never put into a statement. |
| `collectionId` | Only this collection. One the caller may not read gives an empty list with status 200, never 404, so the answer says nothing about collections the caller cannot see. |
| `limit` | 1 to 50, default 20 (narrower than the lists of the API: a headline costs about 4.6 ms a page). |
| `cursor` | What the previous page returned. A cursor this server did not issue is 422 `invalid`. |

A result is `{ pageId, urlId, title, snippet: { text, ranges }, collectionId, rank, updatedAt }`, and `partial: true` when only the start of the page is searchable. `semantic` is `false` and `nextCursor` is `null` on the last page. **There is no total**: it would say how many matching pages the caller cannot see.

The route is limited to 30 requests in 60 seconds for each person (429 after that).

**The snippet is plain text.** `text` is at most 300 characters, and `ranges` are the `[start, end)` offsets, in UTF-16 code units, of the matched words: inside the text and not overlapping. The server never sends markup; the client draws the text as text and wraps the ranges in `mark`. The headline is cut from the page text by `ts_headline` with U+0001 and U+0002 as the match markers. Those two characters are replaced by spaces in the page text before it is handed to `ts_headline`, so every marker in its output is the server's own, and nothing a page contains can fake a match or reach the client as markup. When a page matched by its title only, or its match lies beyond the first 200,000 characters, the snippet is the first 160 characters of the page with no ranges.

## Who sees what

The collections the caller may read are looked up first (`visibleCollections`) and applied **inside the query**, together with the caller's tenant and `deleted_at is null`; ranking, the limit and the cursor only ever see readable pages. The headline statement repeats the same checks, so a page moved out of reach between the two statements is left out rather than read. A person who may read no collection gets an empty list without a query. A search never crosses tenants.

## How it is matched and ranked

- **Text:** `pages.tsv`, maintained by a trigger, holds the title (weight A) and the body (weight B) under the `simple` configuration: no stemming, accents kept, and Chinese and Japanese runs are one token each. `ts_rank_cd` ranks.
- **The tsvector limit.** PostgreSQL refuses a `tsvector` over 1,048,575 bytes. A page whose text does not fit is **never an error on save and never unsearchable**: the trigger retries with the first 600,000, 300,000, 150,000, 70,000, 30,000 and 10,000 characters of the body, and as a last resort the title alone. The page is found by its title and by the words of the indexed prefix, its `search_partial` flag is true, and the result says `partial: true` (the web client shows "Only the beginning of this page is searchable"). A word beyond the indexed prefix is not found. A long text with repeated words fits whole: the limit is about distinct words, not length.
- **Titles that are not typed exactly.** A query of three characters or more also matches a title by trigram similarity (above 0.3, `pg_trgm`) or as a substring, ranked at half the similarity, so a full-text hit always outranks a typo hit. A query of two characters or more that holds a character outside ASCII may also match a title by substring: a run of Chinese or Japanese is one token to the `simple` parser, so substring is the only way to find such a title by one of its words. A short ASCII query matches no title by similarity or substring (it would match nearly all of them). `%` and `_` in the query are characters, not patterns.
- **Order:** rank, then the last edit (newest first), then the page id: a total order, paged by a keyset cursor `base64url({"k":[rank, edit time in microseconds, id]})`. Rank is recomputed on every request, so a page edited between two requests can move; a page is never repeated or skipped by the cursor itself.

## Limits to know

- **Raw HTML blocks are not searched.** The stored search text leaves out the text inside a block of raw HTML (a block is one node and contributes nothing; inline HTML keeps the text between its tags). A word that appears only inside such a block, which is what an imported callout or toggle can be before conversion, is not found. This is the default in force; whether the search text should include the visible text of raw HTML blocks is the owner's decision (`docs/proof/m2-conversion.md`, "Search text").
- **No body trigram search.** A typo in a body word finds nothing; only titles tolerate typos (a trigram index over bodies cost 164 MB and twice the query time in the measurements).
- **Statement timeout.** One search may run `GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS` (default 3,000). Past it the statement is cancelled, the route answers 503 `unavailable` and logs `search.timeout`.
- **Nothing of a query is logged.** `search.query` (debug) carries the milliseconds and the number of results only.
