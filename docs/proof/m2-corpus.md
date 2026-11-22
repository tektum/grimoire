# Proof: regression corpus

Test: `packages/adapters/markdown-milkdown/test/corpus/corpus.test.ts` (574 tests, in `bun run test`, about 6 s of its own on this
machine, of which the 300 KB page is about 4 s). Measured on Node 26, `@milkdown/*` 7.23.0, `marked` 18.2.1.

```
real-meaning-kept: 0/0
gfm-meaning-kept: 32/33
commonmark-meaning-kept: 34/36
```

"Meaning kept" means: the entry converts, and `marked` reads the input and the saved Markdown the same (see "What the
`marked` comparison compares"). The floor for `real` is 12 of 14 (the earlier trial result for Milkdown). **It is not checked in this repository:** the real-document group is not distributed here, so its two floor tests are skipped and the count above is 0/0. In the maintainers' full corpus the floor was met (12 of 14) after the schema fixes (the first measurement was 10 of 14, the findings below). The two that remain differ only in how a link and a strong are
nested (`**[text](url)**` is written `[**text**](url)`), which the reference renderer sees and a reader does not.

**Status of the findings after the schema fixes:** fixed (each entry's expectation was regenerated): the HTML block that opened with a tag, the code
span edge spaces, the empty task item (which `marked` reads as text, a named difference), and a link, emphasis or strong over a soft line break.
Still open: the inner emphasis of nested emphasis (finding 3), a code span over a soft break (finding 2), the nesting order of a link around
strong, YAML front matter (gfm), and the `> 7.` case, where the reader is right and the reference renderer differs.

## What is in it

| Group | Entries | Where | Source |
|---|---:|---|---|
| `real` | 14 | not in this repository | 14 third-party documents (public README files) were used during development; they are not part of this repository and are not reproduced here |
| `gfm` | 33 | `test/corpus/gfm/` | small examples of GitHub-flavoured Markdown written during development |
| `commonmark` | 36 | `test/corpus/own/commonmark/` | written for this repository (the limit is 40; `commonmark-spec` is not used: its licence is not allowed) |
| `wiki` | 7 + 1 | `test/corpus/own/wiki/`, `long-page.ts` | meeting notes, runbook, decision record, Hebrew, mixed right-to-left and left-to-right, CJK, emoji and combining marks; and a page built from a seed |
| `proof` | 44 | `test/corpus/own/proof/` | one or more per row of the tables in `m2-schema-fixes.md` and `m2-conversion.md` (map below), plus the findings below |
| `import-shapes` | 6 | `test/corpus/own/import-shapes/` | **constructed from documentation, not from a real export** (no real export is available yet): `<aside>` callouts, `<details>` toggles, `<br>` in cells, page links with id suffixes, to-do lists, a whole page with property lines |

The page near the size cap is generated in the test from seed 20261120 (ten kinds of block, chosen at random, until 300,000
bytes). Only its sizes and SHA-256 hashes are committed (`test/corpus/long-page.json`). The Yjs state of this mix is about
3.5 times the Markdown: 300 KB gives a state of 1.04 MB, 400 KB gives 1.39 MB, 500 KB is refused as `too-large` (measured by
hand, not asserted: it takes 3 to 6 s). So the state limit (1,536,000 bytes) binds, not the 1 MiB seed limit (finding 8).

### Map: proof-note row to entry

| Row | Entry (under `own/proof/`) |
|---|---|
| schema fixes 1, 1b | `proof-fix01-empty-paragraph-in-item`, `proof-fix01b-mixed-tight-loose` |
| 2, 2b | `proof-fix02-hard-break-at-edges`, `proof-fix02b-double-hard-break` |
| 3, 4, 5 | `proof-fix03-text-before-image`, `proof-fix04-trailing-empty-paragraphs`, `proof-fix05-cell-edge-spaces` |
| 6 | `proof-fix06-break-in-cell-and-heading` |
| 7 | `proof-fix07-mark-adjacency` (and `cm-03`, `cm-04`) |
| 8, 9, 10, 11 | `proof-fix08-...`, `proof-fix09-task-heading`, `proof-fix10-html-at-line-start`, `proof-fix11-level-in-cell` |
| 12 | `proof-fix12-html-start-1-to-5`, `proof-fix12-html-start-6-7` |
| 13, 14, 15 | `proof-fix13-incomplete-html`, `proof-fix14-element-in-one-node`, `proof-fix15-padded-br` |
| normalisations | `proof-norm-underscore-emphasis`, `proof-norm-first-save-style`, `proof-norm-spaces-around-breaks`, `proof-load-bare-br` |
| losses | `proof-loss-address-as-link`, `proof-loss-code-pipe-in-cell`, `proof-loss-overlapping-marks`, `proof-loss-empty-heading-at-end`, `proof-loss-link-around-image`, `proof-loss-loose-list`, `proof-fix09-task-heading` (checkbox before a heading) |
| second-save drift | `proof-drift-quote-list`, `proof-drift-tab-in-cell` |
| converted on load | `proof-load-bare-br`, `proof-load-typed-br-text` |
| known limits | `proof-limit-footnote-math`, `proof-limit-empty-paragraph`, `proof-limit-table-no-alignment`, `proof-limit-whitespace-paragraph`, `proof-limit-javascript-link`, `proof-limit-nul-and-surrogates` |

Rows with no entry: "newline inside a text node", "table cell paragraph with a level arriving through Yjs", "table with zero
columns", "a link mark added to an image in the browser". All four need a hand-built Yjs state; Markdown cannot produce them.
Their canaries stay in `known-limits.test.ts`, `normalisations.test.ts` and `level-contexts.test.ts`.

## How expectations are stored and regenerated

Per entry, under `test/corpus/expected/<group>/`, plain files a person can read and diff:

| File | Content |
|---|---|
| `<name>.outcome.txt` | line 1: `converted`, or `refused <kind>: <detail>`, or `seed-refused ...`; line 2: `second-pass: identical`, or `differs, third equals second` |
| `<name>.out.md` | the saved Markdown (converted entries) |
| `<name>.search.txt` | the search text |
| `<name>.second.md` | the Markdown of the second save, only when it differs from the first |
| `<name>.marked.txt` | only when `marked` reads input and output differently: the two canonical forms, one after the other |

Each entry runs: input Markdown, then `seedInProcess` (document through the shared plugin array, then Yjs state), then
`convertInProcess` (the server's functions), then the same again on the output (the second save), and a third time when the
second differs. Entries are compared with the files by `expect(actual).toBe(committed)`, so a difference shows as the test
runner's own diff with the file path in the message.

**Regeneration is explicit.** The only switch is the environment variable `CORPUS_UPDATE=1`:

```
CORPUS_UPDATE=1 bun run vitest run --project unit packages/adapters/markdown-milkdown/test/corpus
```

It rewrites the whole `expected/` tree and `long-page.json`. Without it nothing is ever written; a missing file fails the test
with the sentence "regenerate with CORPUS_UPDATE=1". The test "a changed output fails, and so does a missing file" proves
this, and "no expected file that no entry owns" fails on stale files.

**How to review a regenerated diff.** Run `git diff --stat packages/adapters/markdown-milkdown/test/corpus/expected`, then read
every changed `.out.md`, `.search.txt` and `.marked.txt` next to its input. A change is acceptable only if you can name why
(a deliberate schema or converter change, or a library upgrade whose release notes say so) and the page a user sees is the same;
otherwise it is a regression: fix the code, not the file. A new `.marked.txt`, a changed `outcome.txt`, or a `second.md` is
never routine: it means a page now changes meaning, is refused, or no longer settles. Update `own/manifest.json` or
`known-exceptions.json` and the counts above in the same commit, and say why in a `Corpus-Change:` line of the commit message (decision 146).

## What the `marked` comparison compares

For every converted entry both the input Markdown and the saved Markdown go through `marked.parse` (GFM on), the HTML is
parsed with `happy-dom` (scripts and file loading off), and a canonical text is built. Compared: element names and nesting,
the attributes `href src alt title start align checked type colspan rowspan open`, the `language-*` class of code, comments,
text with whitespace collapsed, and text inside code verbatim. Ignored, and why:

| Ignored | Why |
|---|---|
| a `<p>` directly inside `<li>` | tight against loose spacing; the converter chooses it |
| whitespace between blocks, soft line breaks | HTML renders both as a space |
| other attributes (ids, styles, classes, data) | presentation, not meaning |
| how neighbouring runs of the same mark are split (`*a**b*`, `*ab*`) | ProseMirror merges them |

Anything else that differs is a difference. A difference must be named: in `own/manifest.json` (`markedDiff`, and `finding`
when it looks wrong) or, for the third-party files, in `known-exceptions.json` (at most 10 entries, each with a reason). The test fails
on an unnamed difference and on a named one that is gone. Second saves work the same way (`drift`). `marked` is not fully
CommonMark: where it disagrees with the reader, the entry is named so that either side can be examined (finding 4).

## Findings: behaviour that looks wrong or surprising

None of these was fixed or hidden. Each has an entry whose expected files show exactly what happens.

1. **A multi-line HTML block that opens with a tag is kept as it is (fixed).** Input `<a href="https://example.org/u">` newline
   `  <img src="https://example.org/p.png" />` newline `</a>` (also `<p align="center">` with an `<img>`; this is the contributors
   badge or logo of 3 of the 14 third-party documents) was once written as visible escaped text and then drifted on the second
   save. It is now written back verbatim and the second save is the same. Entry `proof-finding-html-block-open-tag`.
2. **A code span that spans a soft line break is split in two.** `` `a `` newline `` b` `` is saved `` `a` `` newline `` `b` ``: one code
   span becomes two. A link, emphasis and strong over a soft break were also split once and are fixed: they are saved as one mark.
   Entry `proof-finding-soft-break-splits-marks`.
3. **Emphasis inside strong inside emphasis loses the inner emphasis.** `*a **b *c* d** e*` is saved `*a **b c d** e*`: the inner `c`
   loses its italics, the text and the other marks are kept (`**a *b *c* d* e**` is saved `**a *b c d* e**`). Entry `proof-finding-nested-emphasis`.
4. **`text` newline `> 7. z`** (an ordered list not starting at 1 as the first thing in a quote, with no blank line after a
   paragraph) is read as the paragraph `7. z`; `marked` reads a list. Which reader is right is not decided here. Entry
   `proof-fix08-late-ordered-in-quote`.
5. **Spaces inside a code span at the edge of a block are dropped.** `` `  y  ` `` (content ` y ` after CommonMark's stripping)
   is saved `` `y` `` in a paragraph and in a cell. Entry `proof-finding-code-span-edge-spaces`.
6. **YAML front matter becomes a rule and a heading with a hard break.** `---` title/tags `---` is saved
   `***` and `## title: Page<br />tags: [a, b]`: one heading, two lines. Entry `gfm/frontmatter` (named exception).
7. **A checkbox with nothing after it is an empty task item (fixed on import).** `* [ ]` is saved `* [ ] <br />`, as the editor writes
   an empty task item; `marked` reads the text `[ ]`, so the entry names this difference. Entry `proof-finding-empty-task-checkbox`.
8. **The 1 MiB Markdown limit cannot be reached.** The state is about 3.5 times the Markdown, so a page of 500 KB is refused as
   `too-large` at seeding while the Markdown limit says 1 MiB. Not a loss, but the two limits do not describe the same pages.
9. Smaller: the empty-paragraph `<br />` form shows in `marked` as an extra line break for an empty list item, quote or
   paragraph (`cm-36`); a link wrapped around bold is written with the link outside (`cm-28`); a table row with more cells than
   the header keeps the extra cell (`proof-loss-code-pipe-in-cell`, second row); the two second-save drift classes of the
   schema note (`proof-drift-quote-list`, `proof-drift-tab-in-cell`) do **not** drift when the page starts as Markdown: they are
   stable from the first save, so only a hand-built document reaches them; no corpus entry is refused (`content-lost` needs a
   hand-built state), so no entry asserts a refusal.

## Stability

The corpus test is deterministic (no clock, no randomness except the seeded generator) and runs in about 6 s alone; the
other 3 conversions of the long page dominate. The benchmark project is untouched.
