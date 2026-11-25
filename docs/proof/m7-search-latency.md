# Search latency over 10,000 pages (R9.10)

Measured by `packages/adapters/db-kysely/test/search/latency.int.test.ts`, in the Integration job of this pull request's CI run (a shared runner of the project's CI, PostgreSQL 17 with the pgvector image of the Compose stack, run 45568768871, on the head whose test also guarantees a hit for every search). The figures are what that job printed; they are not from a developer machine, and a loaded runner can be slower.

## What was measured

- **Data:** one tenant of 10,000 generated pages in 100 collections, each page 600 words drawn from a vocabulary of 2,000 (about 4 KB), edited between 0 and 1,000 minutes ago; and 40 small tenants of 25 pages in 2 collections each, with the same vocabulary. 11,000 pages in all, so the full-text index, the trigram index and the table hold every tenant and a query has to stay inside its own.
- **Query:** the two words `w17 w42` (an AND of two words, which matches a few percent of the pages), first page of 20, through `createSearchRepo` exactly as the route calls it: the access predicate and the tenant inside the query, the keyset order, and a headline for each of the 20 rows.
- **Method:** one warm-up request (plan and caches), then seven requests; the figure is the median, and the worst of the seven is shown beside it.

## Results

| Who asks | Collections readable | Median | Worst of 7 | Limit |
|---|---|---|---|---|
| a person in the big tenant who reads every collection | 100 of 100 | 73 ms | 120 ms | 1,000 ms (R9.10) |
| a person in the big tenant who reads one collection in a hundred | 1 of 100 | 11 ms | 16 ms | 100 ms |
| a person in a small tenant | 2 of 2 | 6 ms | 17 ms | 100 ms |

The 100% case returned a full page of 20; the 1% case returned 12 (all that one collection holds for the query, with the page the test adds); the small tenant returned 4. Asking as the small tenant for the big tenant's collection ids returns nothing: the tenant predicate holds whatever collections are named.

## What it says

- R9.10 is met with room: the worst case, a person who sees everything, answers in a median of 73 ms (about 7% of the limit) and at worst of seven in 120 ms (12%). The `EXISTS (select ... visible)` form of the plan was not needed.
- **Decision 14:** `tenant_id` is **not** added to the search indexes. The query filters by tenant and by the readable collections after the index narrows by the words, and 1,000 rows of other tenants in an index of 11,000 did not slow the big tenant or the small ones; the small tenant's 6 ms median (17 ms worst of seven) is what an index of its own would give at this size.
- **What this does not show:** one query, one vocabulary shape (a two-word AND matching a few percent of the pages), one size. A word that matches most pages, a much larger tenant, a loaded database, or the semantic list of M7-T14 added to the answer are not measured here. The statement timeout (`GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS`, 3 s by default) bounds the worst of them.

To repeat it: `make db-up`, `bun run test:integration -- latency` (add `GRIMOIRE_LATENCY_OUT=<file>` to keep the lines it prints).
