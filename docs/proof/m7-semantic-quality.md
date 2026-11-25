# Semantic search: quality and cost of the two models (M7-T12)

Measured on one machine (32 shared cores, Node 26, `onnxruntime-node` 1.31.1, `threads = 2` unless stated), with the real model files of `models/models.lock.json` through the embedder as the server uses it (`apps/server/test/semantic/quality.container.test.ts`, the corpus in `apps/server/test/semantic/corpus/`). Re-run it with `node scripts/fetch-models.mjs` and `GRIMOIRE_QUALITY_OUT=file.json bunx vitest run --project container apps/server/test/semantic/quality.container.test.ts`; it is run again, with no network, inside the image (below).

## Recall at 5

The corpus is 46 passages (English, four Hebrew) and 36 queries: 4 synonyms, 17 paraphrases, 8 questions, 3 exact identifiers (`E-4471`, `INV-2025-0099`), 2 English queries against Hebrew passages, 2 Hebrew queries. A query is found when a passage that answers it is among the five most similar. The required figure is 0.8 for the default model.

| Model | Recall at 5 | Misses |
|---|---|---|
| multilingual-e5-base (default) | **0.97** (35 of 36) | "what is the policy for reporting an outage and who updates the status" (English query, Hebrew passage) |
| multilingual-e5-small | **0.94** (34 of 36) | both English queries against a Hebrew passage |

By kind, base: synonym 4/4, paraphrase 17/17, question 8/8, identifier 3/3, English to Hebrew 1/2, Hebrew 2/2. Small: the same except English to Hebrew 0/2. **An English query is answered by the Hebrew passage only** (the English original of that passage is not among the answers: counting it made an earlier run say 2/2 for base without the model crossing the language; a review caught it), and crossing the language is where the models are weakest: the 0.8 required of the default is met with room, but a workspace with Hebrew pages should expect English searches to miss some of them. **A caveat about the figure**: 46 passages is a small corpus, and the answer to each query is one of few passages that mention its subject, so a high figure says the model finds the obvious paraphrase, not how it ranks among thousands of near neighbours. The same corpus is the regression check; it is not an estimate of recall on a real workspace.

## Similarity: where a minimum could be set (`GRIMOIRE_SEMANTIC_MIN_SIMILARITY`)

The cosine similarity of the best passage for each of 10 searches that match nothing in the corpus ("purple elephants dancing quarterly", "zxqv blorptak fnord", a Hebrew sentence about a purple cat, and so on), against that of the best relevant passage of each real query:

| Model | Best passage of a nonsense search (10, sorted) | Best relevant passage of a query (36): lowest, median, highest | Relevant results below the best nonsense one |
|---|---|---|---|
| e5-base | 0.730 0.745 0.755 0.757 0.759 0.759 0.769 0.769 0.772 0.789 | 0.758, 0.840, 0.885 | 3 of 36 |
| e5-small | 0.771 0.773 0.774 0.778 0.781 0.785 0.793 0.796 0.799 0.828 | 0.740, 0.863, 0.925 | 6 of 36 |

**The e5 models compress cosine similarity into the upper part of the range, and nonsense lands in the same band as real answers.** A minimum that removes every nonsense match (above 0.79 for base, above 0.83 for small) would also remove real answers (the lowest relevant result of base is 0.758: an English query that reaches its Hebrew passage). So the default of `0` is the right one: the similarity decides the order, not whether a result exists. **Fusion alone does not make a nonsense search look empty**: a page that full text does not find has only its semantic rank, and a search that matches no word gets the nearest pages whatever it says, so the search route limits how many pages found only by meaning it returns, and shows why each was returned (the passage); that limit is M7-T14's. If an operator sets a minimum anyway, on this corpus 0.78 loses 2 of 36 real results on either model, 0.80 loses 3 (base) or 2 (small), and 0.82 loses 7 (base) or 3 (small), while the best nonsense match is 0.79 (base) and 0.83 (small): no value separates them. This is a statement about this corpus and not a recommendation.

## Cost

One text to a model run (the weights are quantised with a scale taken over the whole input, so a text's vector would change with a padded batch's other texts: the first real run of the conformance suite showed it). Chunks of about 217 tokens.

| Model | 1 thread | 2 threads | 4 threads | Resident after load | After 200 chunks | Peak |
|---|---|---|---|---|---|---|
| e5-base | 14.3 chunks/s | 26.1 | 34.1 | 744 MB | 771 MB | 829 MB |
| e5-small | 39.5 | 45.5 | 64.4 | 483 MB | 512 MB | 558 MB |

Memory is the whole server-side process of the probe (embedder thread, model thread, tokenizer once): the peak is the process's own `VmHWM`. The plan measured 0.87 GB (base) and 0.70 GB (small) at peak with the tokenizer twice; the budgets the test enforces are 1.1 GB and 0.9 GB. The load takes 1.2 to 2.5 s on this machine. A page of 14 chunks (about 2,000 words) takes about 0.5 s with the base model at 2 threads.

## The image

Measured by the `Image and stack` job on the pull request that added the models to the image (head `204831e`, run on CI: there is no Docker on the machine of the other figures): the image is **679 MiB** (the limit is 900 MiB), with both models and their lock in `/app/models`, the ONNX runtime of the running platform only, and no file named for CUDA or TensorRT. The job also runs the embedder on both models inside the image, with no network, a read-only root filesystem and every capability dropped (`tools/ci/semantic-image-smoke.mjs`). The container limit that goes with it is 3 GiB (`compose.yaml`); the process peaks above are under half of it.

## Not measured here

- **Hybrid ranking and the search route** (M7-T14) are not built: what is said about their behaviour above is the reason for the default of 0 and for the limit on pages found only by meaning, to be confirmed by T14's own tests.
