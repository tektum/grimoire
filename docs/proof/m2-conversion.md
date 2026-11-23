# Proof: Markdown converter, guards and benchmark

Implemented in `packages/adapters/markdown-milkdown` (`convertInProcess`, `seedInProcess`) behind the port
`packages/core/src/ports/markdown-converter.ts`. The worker pool is described in `docs/proof/m2-pool.md`.

option-a-without-dom: works

Option A is Milkdown's own schema, parser and serializer on a bare `@milkdown/ctx` context, with y-prosemirror turning
the Yjs fragment into a document and `textBetween` giving the search text. It runs in plain Node with no DOM. The only
shim is three event functions (`addEventListener`, `removeEventListener`, `dispatchEvent`) bound to an `EventTarget`
(`src/polyfill.ts`). The full editor under happy-dom is built only as the reference editor of the parity tests
(`src/testing/reference-editor.ts`), and the headless Markdown is byte-identical to it
(`test/parity/headless-vs-editor.test.ts`, `real-roundtrip.test.ts`).

Option B: not built

## What the libraries do and what is hand-written

| Step | Done by | Hand-written code and why |
|---|---|---|
| Yjs update to document | `y-prosemirror` `yXmlFragmentToProseMirrorRootNode` | none |
| Document to Markdown | Milkdown's serializer from the headless context | the 15-line headless factory (`headless.ts`) and the event globals: Milkdown has no headless API |
| Search text | ProseMirror `textBetween` | the leaf rule (`leafText`): image alt, a space for a hard break, nothing for raw HTML |
| Guards before conversion | none exists | `guards.ts`: one iterative walk for depth, block count and the counts the loss check compares. Iterative because a recursive walk overflows the stack on the input it must refuse |
| Loss check | none exists | counts only (elements and text characters of the Yjs fragment against the document) |
| NUL and lone surrogates | none | `sanitise`: `String.prototype.toWellFormed` is not in the compiler's ES2023 library |
| Seeding | Milkdown's parser, `prosemirrorToYXmlFragment`, `Y.encodeStateAsUpdate` | fixed Yjs client id, so equal Markdown gives equal bytes |

## Failure kinds

The converter never throws and never returns partial Markdown as success. Every guard runs before conversion, except the
loss check, which needs the converted document.

| Kind | When | Test |
|---|---|---|
| `invalid-state` | not a byte array; bytes that are not a Yjs update; an incomplete update (Yjs applies none of the part whose earlier parts are missing and keeps it pending: without the check the Markdown would be that of the part that arrived); non-empty content under any name except `prosemirror`; map entries under `prosemirror`; text, or anything that is not an element, directly under the root | `test/hostile/hostile.test.ts`, `test/hostile/elements.test.ts` |
| `too-large` | state over `maxStateBytes` (1,000,000); more than `maxBlocks` (50,000) elements; seed Markdown over `maxSeedMarkdownBytes` or a seeded state over `maxStateBytes` | `hostile.test.ts`, `convert/seed.test.ts` |
| `too-deep` | element nesting over `maxDepth` (100), checked before conversion; a `RangeError` raised later (limit raised past what the stack allows) | `hostile.test.ts` |
| `content-lost` | an element or text character in the Yjs fragment that is not in the document: a node outside the schema, a mark outside the schema (y-prosemirror drops the paragraph's text), a known attribute with an invalid value (the node is dropped); a block level that is not an integer from 0 to 6; a table alignment that is not left, center or right; an attribute (on a node or a mark) the schema does not define; and the round trip check below | `hostile.test.ts`, `elements.test.ts`, `convert/round-trip.test.ts` |
| `internal` | any other thrown error | `hostile.test.ts` (serializer made to throw) |

A failure carries its kind and a short detail (at most 200 characters; for `content-lost` a structural description of the first difference: a document path, node type names and child counts): never the text of an error or of the page
(`elements.test.ts`, "a failure carries a fixed sentence").

`timeout` and `out-of-memory` belong to the worker pool.

Depth counts element levels under the fragment: children of the fragment are at depth 1, so a blockquote chain of 99
with a paragraph inside is at depth 100 and converts, and one more fails. A list nests two elements per level (list and
item), so "a list nested 101 deep" is element depth about 203 and is refused; a list nested 50 deep is refused as `too-deep` (the innermost paragraph is at element depth 101, checked), and 49 is the deepest the depth guard lets through.

## Search text

`textBetween(0, size, "\n", leafText)`. One line per block, list item and table cell. Code block text is included as
written, with its own line breaks. A link contributes its text and not its URL. An image contributes its alt text and
not its URL. A hard break is a space. Raw HTML nodes contribute nothing: tags of inline HTML are dropped and the text
between them stays; a block of raw HTML is one node and contributes nothing. No formatting characters appear.
Leading and trailing line breaks are removed and runs of empty lines collapse to one line break (code block text loses its own empty lines too; a page that starts
with a raw HTML block has no leading newline, and a block without text leaves no empty line). An autolink contributes
its URL as text: the URL is the visible text of an autolink, so this is intended. Tests: `test/convert/search-text.test.ts`.
The design states the leaf rule and this note records the rest.

## NUL and invalid UTF-16

The design requires saved Markdown and text without U+0000, and U+FFFD for it. PostgreSQL `text` columns reject the
NUL character; that is documented PostgreSQL behaviour (the manual's character types chapter; the error is "invalid byte sequence for encoding UTF8: 0x00"). A lone surrogate cannot be valid UTF-8, so it is
replaced too (Yjs already writes U+FFFD for one when it encodes a string). Tests: `convert/sanitise.test.ts`,
`hostile.test.ts`.

## Benchmark

Run: `bun run build && bun run test:benchmark` (or `bun run --filter @tektum/grimoire-adapter-markdown-milkdown bench:convert`).
Each step runs in a fresh Node process on the built package: one process builds the state, another converts it, so the
peak memory is the converter's. The limits are raised for the benchmark (a 1 MB page of lists has an 11 MB state, over
the live cap, 1,536,000 bytes when this was measured and 1,000,000 now). Raw numbers: `test-results/m2/bench-<size>.json`.

Measured on a development machine: 32 cores, 63 GB, Linux 6.12 (x64, container), Node v26.8.2, `@milkdown/core` 7.23.0,
`y-prosemirror` 1.3.7, `yjs` 13.6.33. One run; times in milliseconds, memory in MB. Stage times are from the first
conversion in a fresh process (including JIT warm-up); "again" is a second `convertInProcess` call in the same process.

Mixed shape (heading, paragraph, list, quote, table, code per unit) and 50,000 one-line paragraphs. Stages: apply (Yjs
update and guards), Y to document, normal form, serialize, check (parse the Markdown and compare), textBetween. "total"
is their sum. Peak RSS is of the whole process:

| Size | apply | Y to document | normal form | serialize | check | textBetween | total | peak RSS (MB) |
|---|---|---|---|---|---|---|---|---|
| 10 KB | 14 | 4.2 | 2.1 | 25 | 54 | 0.6 | 100 | 162 |
| 100 KB | 54 | 13 | 14 | 149 | 343 | 3.3 | 576 | 298 |
| 1 MB | 368 | 117 | 73 | 1858 | 7846 | 24 | 10286 | 2345 |
| 50,000 blocks | 203 | 65 | 37 | 7037 | 2181 | 7.1 | 9530 | 1135 |

State and total per shape (`generate.ts`, seed 7). "State bytes" is one fresh update from one client, a lower bound.
"again" is a second `convertInProcess` call in the same process, without / with the check. The per-stage table of the
check, including the state cap, is under "Round trip".

| Shape and size | Markdown bytes | State bytes | State / Markdown | total (first run) | again (no check / check) |
|---|---|---|---|---|---|
| prose 10 KB | 10,702 | 17,627 | 1.65 | 50 | 14 / 29 |
| lists 10 KB | 10,890 | 109,528 | 10.06 | 158 | 30 / 87 |
| tables 10 KB | 14,533 | 144,146 | 9.92 | 148 | 45 / 85 |
| code 10 KB | 10,544 | 11,180 | 1.06 | 16 | 2.5 / 4.2 |
| mixed 10 KB | 11,266 | 54,770 | 4.86 | 100 | 25 / 64 |
| prose 100 KB | 106,011 | 174,361 | 1.64 | 173 | 51 / 117 |
| lists 100 KB | 106,081 | 1,110,001 | 10.46 | 1263 | 282 / 1163 |
| tables 100 KB | 142,079 | 1,472,738 | 10.37 | 997 | 350 / 784 |
| code 100 KB | 103,793 | 110,337 | 1.06 | 44 | 5.0 / 27 |
| mixed 100 KB | 110,549 | 554,957 | 5.02 | 576 | 180 / 469 |
| prose 1 MB | 1,084,258 | 1,791,149 | 1.65 | 1208 | 418 / 1125 |
| lists 1 MB | 1,083,064 | 11,427,415 | 10.55 | 64638 | 2668 / 76340 |
| tables 1 MB | 1,443,096 | 14,873,591 | 10.31 | 8762 | 3423 / 10139 |
| code 1 MB | 1,054,573 | 1,121,653 | 1.06 | 283 | 35 / 206 |
| mixed 1 MB | 1,129,366 | 5,667,566 | 5.02 | 10286 | 2396 / 10339 |

Cold start (three fresh processes): about 110 ms from process start until the built package and its libraries are
loaded (this includes Node's own start-up), then about 5 ms to create the Milkdown context, idle RSS 88 MB. 

yjs-bytes-per-markdown-kb: 5139

(Mixed shape at 1 MB: 5,667,566 state bytes for 1,103 KB of Markdown. The ratio depends on the shape: 1.1 for code,
1.7 for prose, 5.0 for mixed, 10.6 for lists and 10.3 for tables; the table above has each.)

state-shrink-after-delete: 0.111

(A 100 KB prose page, 267 blocks, one client: after deleting 90% of the blocks the encoded state went from 174,361 to
19,435 bytes, 0.111 of the original, and the Markdown from 106 KB to 9,981 bytes. Yjs frees the deleted content and
keeps small markers, so the state does shrink. A page with a long multi-client edit history is not measured: R3.19 stays
open for that part.)

Findings from the numbers: at the state cap of that time (1,536,000 bytes, a state of about 1.5 MB, then the largest page that could be live; the cap is now 1,000,000 bytes, so a live page is smaller than the pages measured here) the whole
conversion takes 0.35 to 2.0 s here (prose 1.1 s, lists 2.0 s, tables 1.0 s, mixed 1.6 s, code 0.35 s), of which the
read-back check is 0.3 to 1.6 s: about 2 to 8 times the serialization. The cap keeps every live page inside the 10 s
timeout of the design with a factor of five or more, with the check on. Offline conversions above the cap are costly:
1 MB of mixed content takes 10 s, 1 MB of tables 8.8 s and 1 MB of lists 65 s with 3.2 GB of peak RSS (the parse of a
list-heavy page is superlinear: 42 times its serialization), and 50,000 blocks take 9 s; such conversions need
`verifyRoundTrip: false` or a longer timeout, and a state of 50,000 blocks (3.8 MB) is refused by the default
`maxStateBytes` anyway. The pool and the deployment decide those settings; the 512 MB heap limit is untested here
(peak RSS at the cap is 300 to 830 MB, which is not the heap, but it is close enough that it must be tested before relying on it).

## Round trip: the saved Markdown must read back as the same document

History: the first version of this check found that an emptied list item swallowed the next block (447 of 1,000
generated documents refused); a later schema fix removed that cause and added `normaliseForMarkdown`.

Canonical Markdown has to be a fixed point: what is stored must re-parse to the document it was written from, or import,
seeding and history diffs drift. On every conversion (`verifyRoundTrip`, default on) the converter:

1. builds the document from the Yjs state (y-prosemirror), runs the guards and the count check;
2. takes the normal form `normaliseForMarkdown(document)` and writes the Markdown **and the search text** from it, so the
   two describe the same document (tests: a trailing hard break and trailing spaces are in neither; the search text of 100
   editor documents equals `textBetween` of the normal form);
3. parses the Markdown it wrote and compares that document with the normal form (`compareDocuments` in `guards.ts`).

(A hard break inside a heading is no longer refused: it is written as an inline `<br />` and reads back equal; `round-trip.test.ts`, the block on what the schema now converts.)

**The comparison rule.** Node types, attributes, marks and text must be equal, except for these named rules, each
with a test in `test/convert/round-trip.test.ts` and `compare.test.ts`:

| # | Rule | What a reader sees | Smallest case |
|---|---|---|---|
| 0 | the list `spread` flag is not compared | nothing: a writer hint | any list |
| 1 | **address becomes link** (design decision): a text run that the reader made a link whose target is the run's own text (with `mailto:`, `http://` or `https://` in front) and which the normal form had no link on is read as plain | the address is clickable; no text changes | `see www.example.org now` |
| 2 | **second-save drift** (design decision): Markdown text that changes once more on the next save while the document stays equal never reaches the comparison | nothing | setext heading, `-` bullets, bare URLs |
| 3 | U+0000 and lone surrogates are replaced on both sides (the converter's own `sanitise`) | a replacement character where the page had an invalid one | `a\u0000b` |
| 4 | **space at the edge of a marked run**, see below | nothing | strong `x ` followed by plain text |
| 5 | the order of marks is not compared (marks are a set; Yjs and ProseMirror order them differently) | nothing | strong+emphasis against emphasis+strong |

**Rule 4, exactly.** The writer moves ONE ordinary space (U+0020) at the start or end of a marked run to outside the marks
that start or end there (`** x**` is not strong in CommonMark). A character is covered only if all hold, in the same block:
(a) it is a single U+0020 (never a tab, a no-break space, a zero-width space, a line separator; two spaces in a row are
never covered); (b) it is next to a non-whitespace character that carries exactly its marks, so it is the edge of a
longer marked run and not a run of whitespace only; (c) its other neighbour has different marks, so it is an edge and not
inside the run. What it then loses are only the marks the writer cannot keep on an edge space: emphasis, strong,
strike-through and link; inline code keeps its spaces, so it is never dropped. Accepted: the edge space of an emphasis,
strong, strike-through and link run, at the end and at the start of the run (`compare.test.ts`). Refused: a lone link,
inline code, strike-through, strong or emphasis space between letters; a tab, no-break space, zero-width space or line
separator at an edge; two spaces; a letter at an edge; a space inside a run; an inline code space.

**Whitespace-only marked runs: found, not tolerated by the converter.** `normaliseForMarkdown` already removes link, strike-through and strong from a run of one space between letters (checked for those three: `a`, a marked space, `b`
normalises to `a b`; inline code is NOT removed, code text is never trimmed, and a lone code-marked space is saved as a code span of one space, pinned in the same test file). So such a page is saved as `a b` while the live document keeps the mark, and the comparison needs no
rule for it. This is a visible-in-principle difference (a clickable or struck gap) that the schema's normal form removes
silently; it is a separate case from the edge-of-a-marked-run row of the "Normalisations" table in `m2-schema-fixes.md`. Pinned by `round-trip.test.ts` "whitespace-only marked runs", so a change of the
normal form is noticed.

**Inline code is the exception:** it is not removed from a whitespace-only run, because code text is never trimmed, so `a`, a code span holding one space, `b` keeps the space inside the code span. Link, strike-through and strong are removed from a whitespace-only run as described above (that paragraph is true for those three only). The test "whitespace-only marked runs" in `round-trip.test.ts` pins both.

**Everything else is `content-lost`** (the page keeps its live state and its stored Markdown; the failure names the
place by node types and counts, never page text).

**Every listed loss of `m2-schema-fixes.md` is refused or covered, one test each**
(`round-trip.test.ts`, "listed losses"):

| Listed loss | Converter behaviour |
|---|---|
| Address read back as a link | accepted, rule 1 |
| Task checkbox in front of a heading | **refused** (`content-lost`) |
| Two runs with partly overlapping marks and a space between (emphasis+strong, then strong+link) | **refused** (the marks differ on letters) |
| A newline character inside a text node | accepted: written as a line break and read back as the same text |
| A list written loose where it was tight | accepted, rule 0 |
| Empty heading at the end of the document | the normal form drops it, so the page converts without it (Markdown `a`) |
| A link around an image plus other content; a link mark on an image | not detectable: Yjs drops the mark before the converter sees the page (test pins that the link is absent from the Markdown) |
| Bullets with `*`, setext headings, bare URLs | accepted, rule 2 |

Fixed by the schema and now converting (`round-trip.test.ts`, the block on what the schema now converts and reads back equal): a hard break in a table cell or a heading, a list not starting at 1 first in a quote after a paragraph, inline
code touching another mark, a link between emphasised and strong runs. Emphasis is now always written with `*`: the golden
file `30-emphasis` changed from `_em2_` and `__strong2__` to `*em2*` and `**strong2**`.

Counts, seeded documents (full size: `test/benchmark/sweep.test.ts`, in `bun run test:benchmark`; a smaller sweep of the same code, 150 and 300 documents, runs in `bun run test` as `round-trip.test.ts`):

| Set | Converted | Refused |
|---|---|---|
| 2,000 documents read from Markdown (seeds `i*7919`, i=1..2000) | 2,000 | 0 |
| 2,000 editor documents (`generateEditorDocument`, seeds 1..2000) | 1,814 | 186, all a task checkbox before a heading |

Every accepted editor document was one read-back from an exact fixed point, with one known exception: an address-like link
whose target is not a valid autolink (`me@example.coma_b`) is written `<me@example.coma_b>`, which a reader does not take
for a link; the read-back of such a page is refused when converted (state kept). It happened in 1 of 2,000
(`round-trip.test.ts` pins that it stays under 10).

Cost of the check (parse the Markdown, compare) next to the other stages, at the state cap of that time (a state of about 1.5 MB, the
largest page that could be live; the cap is now 1,000,000 bytes) and at 10 KB, 100 KB and 1 MB of Markdown:

| Shape and size | State bytes | serialize (ms) | parse (ms) | compare (ms) | check (ms) | check / serialize | total (ms) | peak RSS (MB) | exact |
|---|---|---|---|---|---|---|---|---|---|
| prose state cap | 1,502,629 | 299 | 607 | 116 | 723 | 2.4x | 1106 | 331 | True |
| lists state cap | 1,519,552 | 205 | 1463 | 128 | 1592 | 7.8x | 1964 | 832 | True |
| tables state cap | 1,509,352 | 191 | 501 | 127 | 628 | 3.3x | 986 | 626 | True |
| code state cap | 1,497,154 | 35 | 267 | 20 | 287 | 8.1x | 347 | 300 | True |
| mixed state cap | 1,629,606 | 336 | 922 | 140 | 1062 | 3.2x | 1593 | 716 | True |
| prose 10 KB | 17,627 | 13 | 27 | 3.3 | 30 | 2.3x | 50 | 115 | True |
| lists 10 KB | 109,528 | 33 | 87 | 14 | 100 | 3.1x | 158 | 182 | True |
| tables 10 KB | 144,146 | 31 | 76 | 13 | 89 | 2.9x | 148 | 182 | True |
| code 10 KB | 11,180 | 2.9 | 8.4 | 0.6 | 8.9 | 3.1x | 16 | 95 | True |
| mixed 10 KB | 54,770 | 25 | 49 | 5.4 | 54 | 2.2x | 100 | 162 | True |
| prose 100 KB | 174,361 | 49 | 92 | 14 | 106 | 2.1x | 173 | 169 | True |
| lists 100 KB | 1,110,001 | 149 | 887 | 90 | 977 | 6.5x | 1263 | 571 | True |
| tables 100 KB | 1,472,738 | 189 | 497 | 127 | 624 | 3.3x | 997 | 621 | True |
| code 100 KB | 110,337 | 4.8 | 32 | 1.9 | 34 | 7.1x | 44 | 121 | True |
| mixed 100 KB | 554,957 | 149 | 294 | 49 | 343 | 2.3x | 576 | 298 | True |
| prose 1 MB | 1,791,149 | 334 | 666 | 112 | 778 | 2.3x | 1208 | 369 | True |
| lists 1 MB | 11,427,415 | 1462 | 61218 | 970 | 62188 | 42.5x | 64638 | 3154 | True |
| tables 1 MB | 14,873,591 | 1739 | 4033 | 1522 | 5555 | 3.2x | 8762 | 3114 | True |
| code 1 MB | 1,121,653 | 28 | 220 | 15 | 235 | 8.4x | 283 | 316 | True |
| mixed 1 MB | 5,667,566 | 1858 | 7335 | 511 | 7846 | 4.2x | 10286 | 2345 | True |
| 50,000 blocks (table) | 3,784,747 | 7037 | 1913 | 268 | 2181 | 0.3x | 9530 | 1135 | True |

## Addresses, early refusals, line endings

**Address allow-list** (`isSafeUrl` in `packages/editor-schema/src/index.ts`, one function). Links: `http`, `https`, `mailto`,
`tel`, `sms`, `xmpp`, `irc`, `ircs`, `ftp`, `ftps`, `matrix`, `geo`. Images: `http`, `https`. Relative references and
fragments are accepted for both, and so are protocol-relative addresses (`//cdn.example.com/a.png`, also for images).
Anything else is refused, in any spelling a browser reads as a scheme: other schemes, case changes, tabs, newlines or
invisible characters inside, entity or percent spellings of the scheme, leading or trailing spaces, control characters,
more than 8,192 characters. The parse runners, `toDOM` and the normal form the converter writes from all use it.

A refused address becomes: link -> its text without the link; image -> its alt text (nothing if it has none); image link ->
the image without the link. Example: `[x](javascript:alert(1)) ![pic](data:text/html,hi)` is saved as `x pic`. The converter
neutralises instead of refusing the save because a Yjs state can carry any address from any client: refusing would let one
hostile editor stop the Markdown of a page from ever updating, while neutralising keeps the save going and the Markdown inert
(pinned by `test/hostile/urls.test.ts` and the corpus entry `proof-fix-url-schemes`).

**Early refusals, state to Markdown** (typed `too-large`, in `convert.ts` and `guards.ts`). The Markdown serializer is quadratic in
the children of one block, so more than 25,000 children in one block after the normal form is refused. The Markdown that has been
written is refused when it is over 1 MiB (the stored-Markdown cap, so that anything stored can be rebuilt, see below); the message
names the limit. There is no delimiter budget any more: the verifying parse of the written Markdown is bounded by the save
direction's time limit (10 s by default, `GRIMOIRE_SAVE_TIMEOUT_MS`), and nesting by the depth guard (100). Saving a large code listing, a long
task list or a link table works (measured: a 2,500-line Python block 42 ms, 150 KB of JSON 20 ms, 3,000 tasks 1.0 s, a 1,000-row
link table 1.2 s of CPU; the largest that saves is bound by the state cap: about 4,000 tasks or 880 link rows at 1,000,000 bytes; at the former cap of 1,536,000 bytes it was about 5,500 tasks or 1,200 link rows, 1.5 s). A page whose
Markdown cannot be verified in time ends as a `timeout`: the edit is kept, the Markdown stays stale and the alarm is raised once per
streak, as for any failed conversion. The CPU time of every shape at the state cap is printed with its margin under the save limit and flagged `UNDER 2x` (informational, it never fails a build): `bun run test:benchmark`
(`test/benchmark/cpu-time.test.ts`).

**Rebuild from stored Markdown (reseed).** `reseedInProcess` and the pool's `reseed` are a separate entry point for Markdown that the
converter's own serializer stored: up to 1,048,576 bytes, no line cap, 100 markers on a line (the most the depth guard lets the
serializer write), and 30 s (`GRIMOIRE_RESEED_TIMEOUT_MS`). The user's `seed` reads none of these limits (tests: `seed-precheck.test.ts`,
`pool/reseed.test.ts`; the build checks `src/testing/user-seed-types.ts`). Only the collaboration host's open path uses `reseed`; the
HTTP API, the importer and any user-supplied text use `seed` with the signed-in user's id. Invariant: what saving stores can be
rebuilt by `reseed` and saved again to a Markdown that is a fixed point (property test `save-then-reseed.test.ts`; the first re-save
can differ in one accepted way, a bare web address written as text and read back as an autolink).

**Markdown to a page (seed): the pre-check and the time limit.** Hostile or just very dense Markdown can make the Markdown
parser slow, and the parser's time cannot be predicted from the text without imitating the parser. So the protection has two
parts, and only the second is a guarantee.

1. A cheap check in one linear pass, with no parsing (`seedMarkdownProblem` in `guards.ts`). It refuses, with `too-large` and a
   sentence that names the limit and the numbers:

   | Limit | Default | Setting | What the person sees |
   |---|---|---|---|
   | Size | 131,072 bytes (128 KiB) | `GRIMOIRE_SEED_MAX_MARKDOWN_BYTES` | "the Markdown is N bytes; the limit is 131072 bytes" |
   | Lines (LF, CRLF or a lone CR each end one) | 8,000 | fixed in the adapter | "the Markdown has {lines} lines; the limit is 8000 lines" |
   | Quote and list markers in the prefix of one line | 50 | fixed in the adapter | "line N has M quote or list markers; the limit is 50 per line" |

   Measured on the real parser, a line with 800 markers parses in 18 ms, 4,000 markers in one line overflow its stack, and
   a document of many lines with a few nested markers each costs seconds: 50 leaves a wide margin on the first two. The line
   limit follows from block-dense text costing about 0.24 ms of CPU per line: 8,000 lines is about 2 s. The largest real
   documents of the corpus have 418 lines and 16 KB, so the limits leave them about 19 times of room for lines and about 8 times for size (131,072 / 16,000). There is no
   delimiter budget any more: large code listings, JSON blocks, long task lists and link tables are accepted up to the size limit.

2. The time limit is the bound. A seed that is still running after `GRIMOIRE_SEED_TIMEOUT_MS` (default 10,000, queue wait plus run)
   ends as `timeout` with the sentence "the Markdown took too long to convert (limit N ms)"; its worker is stopped and replaced and
   nothing keeps running. Conversion of a page's state to Markdown keeps its own limit (`GRIMOIRE_SAVE_TIMEOUT_MS`, 10,000 ms by default). Residual: a hostile import can hold one of the two workers for up to the seed limit (10 s), and two hostile callers at once make a third wait up to one time limit.

**Honest limits.** The pre-check does not make parsing time predictable: some inputs under all three limits take far longer than
the time limit (for example tens of thousands of unmatched `]` or `*a_` in one line), and each of those occupies a worker until
the limit stops it. Isolation limits the damage: there are two workers by default (`GRIMOIRE_CONVERT_POOL_SIZE`; each costs about
90 MB of memory); a caller key may have one seed running at a time, and a second one from the same key is refused at once with
"one at a time" (`internal`, detail `one-at-a-time`), never queued; the per-page rule stays. The key is the caller on whose behalf the conversion runs: the user when there is one, the page for system-initiated seeds. **Not yet met:** the planned HTTP API must pass the signed-in user's id as the key; today the only caller passes the page id, so one user is not yet limited to one conversion. A slow document from one key
never delays another key by more than the time to hand the job to a free worker. Residual limit: if two different keys each
hold a worker with a document that runs to the limit, a third key waits at most one time limit; if the workers are still busy
then, its call ends as "took too long" and it can be retried. The two workers are shared with the conversion of state to
Markdown, which waits in the same way.

**Line endings.** In text, CR, CRLF and LF are each one hard break. In a code block, CR and CRLF become LF. U+2028, U+2029,
U+0085, vertical tab and form feed are kept as they are and read back equal. Example: the text `a\rb` is saved as `a` newline `b`
(`test/convert/line-endings.test.ts`).

## Not the converter's job

Rendering and paste handling in the web client must still refuse dangerous schemes and set `rel="noopener noreferrer"`: the
converter keeps unsafe addresses out of the stored Markdown (above) but is not the only line of defence.

## Known limits

Losses that remain, with canary tests in `test/convert/known-limits.test.ts` and
`packages/editor-schema/test/yjs-losses.test.ts`.

| Case | What happens | Detected by the converter | Open question |
|---|---|---|---|
| A link around an image and other content (`[![a](b.png) tail](c)`) | The link stays on the text and is lost on the image: `![a](b.png) [tail](c)` | No (a mark on an inline atom is not in the counts) | Accept, or restrict links around images in the editor |
| A link mark put on an image in the browser | Same loss | No | the web client must set the image's `href` attribute instead |
| An attribute with a `null` value | y-prosemirror does not store it | No | Fixed for table alignment; none known elsewhere |
| An empty paragraph | Written as `<br />` | n/a (the serializer's choice) | Accept |
| An empty heading | Written as its marker only (`##`) | n/a | Accept |
| Footnotes and math | No plugin: they are plain text. `\,` inside `$$` is read as an escaped comma and written as `,` | n/a | Add the Milkdown math and footnote plugins to the schema if they are wanted (a schema change) |
| Bullets use `*`, rules `***`, bare URLs `<url>` | First save rewrites the text; stable after | n/a | Canonical style (R3.7) |
| Listed losses of the schema note: a task checkbox in front of a heading; two runs with partly overlapping marks and a space between | The page cannot be written as Markdown without a visible change | Yes: `content-lost`, state kept, stored Markdown not updated | Accept the refusals (the editor refuses the heading choice on a task item and can hide it), or change the editor so it cannot make them |
| Plain text that looks like an address | Read back as a link (text unchanged) | Accepted by rule 1 | none |
| A paragraph of spaces only | Written as spaces, reads back as no paragraph | No (deliberately tolerated: only whitespace) | Accept |
| Serializer cost grows faster than block count | 50,000 blocks take 7 s | `too-large` above 50,000 blocks | Tune `maxBlocks` and `timeoutMs` in the server if needed |
| A document the guard accepts can still overflow the stack in the serializer | Reported as `too-deep` | Yes, by the `RangeError` catch | none |

## Recommendation

Use option A as built. Keep the pins exact and the golden files and parity tests in CI: the converter depends on Milkdown
internals that have no supported headless API. Run it in the worker pool (`docs/proof/m2-pool.md`) with the default limits and the read-back check on; at the state cap a
conversion takes under about 2 s here (Findings above). The converter now follows the schema package's normal form and
refuses the listed losses by name, so a refused save keeps the live state and the previous Markdown.
