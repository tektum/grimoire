# Semantic search: operating it

Semantic search finds pages by meaning as well as by words. A model that runs inside the server turns each page into vectors (one per chunk of about 200 tokens), and a query is turned into a vector the same way. What the search does with them is in [search.md](search.md); this page is for the person who runs the server. Everything here is local: no page text leaves the process and nothing is downloaded at run time.

Nothing about it is in the path of a save. A page is saved and shown as before; a background sweep notices that its Markdown changed and embeds it a little later. If semantic search is off or its model is not ready, search is full-text search alone (one exception, under "When the model is missing or cannot load").

## Settings

| Setting | Default | Range | What it does |
|---|---|---|---|
| `GRIMOIRE_SEMANTIC_SEARCH` | `on` | `on`, `off` | `off` starts no model and embeds no page; the server runs at its old size. |
| `GRIMOIRE_SEMANTIC_MODEL` | `multilingual-e5-base` | `multilingual-e5-base`, `multilingual-e5-small` | The model. A change re-embeds every page (see below). |
| `GRIMOIRE_SEMANTIC_MODEL_DIR` | `/app/models` | an absolute path | Where the model files are read from. Nothing else is read, and nothing is fetched. |
| `GRIMOIRE_SEMANTIC_THREADS` | 2 | 1 to 4 | Threads of the one embedding worker. |
| `GRIMOIRE_SEMANTIC_DEBOUNCE_SECONDS` | 30 | 5 to 3,600 | A page is embedded when it has been left alone this long, so a page being typed in is embedded once, after it settles. |
| `GRIMOIRE_SEMANTIC_SWEEP_SECONDS` | 15 | 5 to 600 | How often the sweep looks for pages that need embedding. |
| `GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE` | 600 | 1 to 100,000 | The cap on embedding work, whatever the backlog. |
| `GRIMOIRE_SEMANTIC_QUERY_TIMEOUT_MS` | 1,500 | 100 to 10,000 | A query that cannot be embedded in this time is answered by words alone. |
| `GRIMOIRE_SEMANTIC_MIN_SIMILARITY` | 0 | 0 to 1 | Chunks under this cosine similarity are not results. 0 keeps every one and leaves the order to the fusion. |
| `GRIMOIRE_SEMANTIC_CANDIDATES` | 100 | 10 to 500 | How many pages each of the two lists hands to the fusion. |

The jobs run in the roles `api` and `all`. A `collab` process starts no model and registers none of them.

## How a page gets embedded

1. The **sweep** (`embed-sweep`) runs every `GRIMOIRE_SEMANTIC_SWEEP_SECONDS`. For each tenant it picks up to 50 live pages that were left alone for the debounce time and whose Markdown, or model, differs from what was embedded last, and queues one `embed-page` job per page (a page that is already waiting is not queued twice). Saves, imports and restores need no hook: the comparison finds them all.
2. **`embed-page`** cuts the page's text into chunks (about 200 tokens, never above 400), keeps the chunks whose text did not change, and embeds only the new ones, at most 16 at a time through the embedding worker (fewer at a low cap, so that one batch's wait for the cap stays under about 4 minutes). It then replaces the page's chunks in one transaction that checks the Markdown again: a page edited meanwhile is left for the next sweep.
3. Each batch but the last is stored as it is made, so a page that takes more than one run (a low cap, a long page) keeps what each run did.
4. The **cap** is a token bucket in each server process: `GRIMOIRE_SEMANTIC_MAX_CHUNKS_PER_MINUTE` chunks a minute however many pages wait. Every process that runs the jobs has its own bucket, so the cap of a deployment with several is the cap times their number.

A failed embed is retried three times with a growing delay, then the job lands in the dead-letter queue. After three failed attempts at the same Markdown and model, the sweep stops picking the page up until its Markdown changes. A failure is recorded as a reason code, never as text.

## Changing the model

Set `GRIMOIRE_SEMANTIC_MODEL` and restart. A new version of the same weights counts as a change too: a page's chunks record the model's name and version.

- The sweep re-embeds every page in the background, 50 pages per tenant per run, and each page's chunks are replaced as its job finishes. The old rows are replaced, not added to, so storage does not double.
- **Search keeps working throughout.** It reads only the rows of the model that is running, so a page that has not been re-embedded yet is found by its words, and by its meaning once its turn has come. Coverage rises while the sweep runs.
- The first sweep of the process that knows the model says how many pages are waiting: the event `semantic.reembed_started` with the model and the count. A restart in the middle of a rollout says it again, for the pages that are left.
- **How long it takes** is set by the cap, not the CPU. At the default 600 chunks a minute, 200,000 chunks (about 14,000 pages) take about 5½ hours. `multilingual-e5-base` int8 manages about 16 to 50 chunks a second on one to four threads, which is 1,000 to 3,000 a minute. Raise the cap to go faster, if the server has the room.

## Memory and sizing

The model adds to the memory of the process, and the memory guard of the collaboration server does not see it: that guard counts the V8 heap only, and the model runs in a worker thread with native memory. So nothing refuses work before the container runs out of memory; the size of the container is what protects it. Measured ([research](research/13-semantic-search.md)): the peak resident memory of `multilingual-e5-base` int8 is about 0.87 GB and that of `multilingual-e5-small` int8 about 0.70 GB. The sizing in the spec for semantic search on is 1 vCPU and 3 GiB for `multilingual-e5-base`, and 2 GiB for `multilingual-e5-small`; with it off, the old size (half a CPU and 1 GB) is enough. Resize before you turn it on.

The database holds one vector per chunk (768 numbers for `multilingual-e5-base`, 384 for `multilingual-e5-small`), kept in the row. Past a certain size the exact scan wants the vectors in the database server's cache, so the size of the database is part of the limit. See "When to change the index" in [search.md](search.md): the point is 200,000 chunks (about 14,000 pages) or a 95th percentile of the semantic statement over 400 ms.

## When the model is missing or cannot load

The server does not depend on the model to run, and `/readyz` does not mention it. If the files are missing, do not match their pinned checksums, fail to load or fail while running, the embedder reports `unavailable` and writes one `semantic.unavailable` event for that streak, with the reason: `model-missing`, `model-hash-mismatch`, `load-failed` or `runtime-failed`. It tries to load again every 60 seconds.

While it is not ready:

- Search answers with full-text search alone (`semantic` is false in the answer). The one exception is a request that continues a hybrid answer with its cursor: it cannot be answered from another order, so it is 503 `unavailable` ("try again") until the model is back, not a page that skips or repeats rows. A client paging through results when the model goes away will see this (a search that ran into its statement timeout is also 503, with its own `search.timeout` event).
- The sweep queues no page (it cannot know the model's key before the model has loaded); the next run looks again.
- An `embed-page` job that was already queued fails without recording anything against the page, and is retried.

Fix the files (`GRIMOIRE_SEMANTIC_MODEL_DIR` must hold the model the setting names) and the next attempt loads them. Nothing needs a restart.

## Turning it off

`GRIMOIRE_SEMANTIC_SEARCH=off` starts no model and embeds no page, and search is words alone. The chunks already stored stay; nothing deletes them, and they are removed with their pages when a page is purged. Turning it on again resumes: pages whose Markdown did not change since they were embedded need no work, and the sweep embeds the rest.

## What is never logged

No page text, no query and no vector reaches a log line, an event, a job row or an error message. A job's payload is the tenant id and the page id. The table of chunks holds the offsets of each chunk in the page's text and its vector, not the text itself (the text is read from the page when a result needs it).
