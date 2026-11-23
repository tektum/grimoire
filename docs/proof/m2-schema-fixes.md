# Proof: schema fixes, known limits and state size

Measured on Node 26, `@milkdown/*` 7.23.0, `y-prosemirror` 1.3.7, `yjs` 13.6.33. Tests: `packages/editor-schema/test/`.

## Round-trip losses through Yjs

y-prosemirror stores marks only on text and omits `null` attributes, so two things the preset parses correctly were
lost after Markdown to document to Yjs to document to Markdown. Both were measured against the plain presets first, then
fixed inside the shared plugin array (`grimoireEditorPlugins`) with `extendSchema`; no Markdown serializer was written.

image-link: fixed
Tried: (1) read `[![alt](src)](href)` into two new string attributes of the image node (`href`, `linkTitle`; attributes
survive Yjs) with `linkSchema.extendSchema` (`parseMarkdown`: a link whose only child is one image becomes one image
node) and `imageSchema.extendSchema` (`toMarkdown`: an image with `href` is written inside a `link`). Result: the
image, its title, the link and the link title survive a Yjs round trip, also inside running text
(`yjs-losses.test.ts`).

table-alignment: fixed
Tried: (1) `tableCellSchema.extendSchema` and `tableHeaderSchema.extendSchema` with the `alignment` attribute default
`null` instead of the preset's `left`; the missing attribute after Yjs now reads back as `null`. Result: an unaligned
table stays `| - | - |`, and left/centre/right alignment still round trips (`yjs-losses.test.ts`).

link-marks: fixed
Tried: (1) first checked without Yjs: `[*em* and **st**](u)` is already written as `*[em](u)* [and **st**](u)` straight
from the document, so it is serializer behaviour and not a Yjs loss. Cause: mark rank is registration order and the
preset registers `link` after emphasis and strong, so the link is the innermost mark and Milkdown's serializer closes it
at every change of the outer marks. (2) Registered the link group before emphasis in `grimoireEditorPlugins`
(`moveBefore`): the link is now the outermost mark and one link wraps the text, with and without Yjs
(`yjs-losses.test.ts`, "link with mixed marks"). `excludes` and `spanning` were not needed. Side effect, still
meaning-preserving: `*[em](u)* [and **st**](u)` is now written `[*em*](u) [and **st**](u)`.

## Fixed point: Markdown must read back as the same document

`normaliseForMarkdown(doc: Node): Node` (exported from `@tektum/grimoire-editor-schema`; pure, idempotent) returns the
document as Markdown can keep it. It and the Markdown writer share one implementation (`normalisedBlock` for text blocks,
the same trailing-empty rule for the document), so they cannot drift. For every document: `serialise(doc)` equals
`serialise(normaliseForMarkdown(doc))`; reading the Markdown back gives `normaliseForMarkdown(doc)` (list `spread` flags
and the marks that cover a space at the edge of a marked run aside) except for the Losses below; and
`normaliseForMarkdown(normaliseForMarkdown(doc))` equals `normaliseForMarkdown(doc)`. The converter compares against the
normal form, not against the live document. The live document and Yjs are never rewritten (no plugin transaction).

`test/round-trip-property.test.ts` checks all three statements on 2,000 seeded documents (`test/generate.ts`: every node
and mark, empty paragraphs and items in every position, nested lists with a nested block first, hard breaks everywhere,
adjacent marks, empty cells, code blocks holding fences, tables in items, text of Markdown-significant characters,
`\n` in text) and again on 2,000 "wild" ones (web and email addresses, inline code beside text, task headings, hard
breaks in cells, edge spaces in marked runs). Statements 1 and 3 had 0 failures in both runs.

Headline numbers (as `bun run test` prints them). 2,000 ordinary documents: **1,992 full fixed points**, 0 losses, 8 second-save drift, 0 unclassified. 2,000 wild documents (nbsp, `\n` in text, tables at any depth, task headings): 1,514 full fixed points, 473 task checkbox in front of a heading (a loss, below), 0 drift, 17 differing only in which marks cover a space, 0 unclassified. (Web and email addresses are a third mode, `addresses`, kept out of the other two because they would
drown every other class.) The generator now includes raw inline HTML (`<b>`, `</b>`, `<div>`, `<pre>`, comments, bare
breaks). Statements 1 and 3 had 0 failures. **Html-heavy mode** (`html`: raw inline HTML at high frequency: the seven
HTML block start conditions closed and not, whole elements, padded and doubled breaks, tags, comments): 1,487 of 2,000 full fixed points, 505 task checkbox in front of a heading, 2 quote-list drift, 6 differing only in which marks cover a space, 0 unclassified.

**Editor-made documents** (`test/editor-made.ts`, own generator: hard breaks in paragraphs, headings and cells,
task items with headings, adjacent bold, link and inline code, ordered lists not starting at 1 nested in quotes and lists,
empty items, a trailing empty paragraph, at higher than realistic frequency): **1,364 of 2,000** are full fixed points (599 task checkbox before a heading, 37 second-save drift, **0 other**). Without the task-heading documents (the editor now refuses to make
them) all but the drift documents are full fixed points.

### Fixes in the shared plugin array (each: what was tried)

| # | Class | Fix | Rejected |
|---|---|---|---|
| 1 | An empty paragraph is written `<br />`; in a tight item it swallows the next block | The gfm list item is written loose when a block would run together (`listItemLooseWhenNeeded`, `extendListItemSchemaForTask.extendSchema`); the list is loose when an item is (`bulletListLoose`, `orderedListLoose`) | A blank line or `&nbsp;` for the empty paragraph (changes the text; a blank line is dropped on reading); no empty first paragraph (the content rule and the browser need it) |
| 1b | Mixed tight/loose output (forced blank lines), which read back loose | Same rule, using the cases of `mdast-util-to-markdown`'s `join` plus: after a table, any block | Forcing every multi-block item loose |
| 2 | Hard break at the start or end of a block lost | Dropped when written and in the normal form | Writing it so it survives: a backslash at the end of a block is literal |
| 2b | Two hard breaks in a row split the paragraph (a bare newline pair is a blank line) | The second is written as a backslash break; it reads back as a hard break of the other kind (`isInline: false`, no visible difference) | Dropping one (a visible blank line would vanish): rejected, so this is not a loss |
| 3 | Text ending in whitespace was written raw by Milkdown's `text` handler, so `[a](b) ` or `<b> ` before an image or mark became a link or HTML | `escapingTextWriter` (one `handlers.text` entry; installed in a plugin's synchronous part, before `init` builds the processor) | |
| 4 | Several trailing empty paragraphs | `docWithoutTrailingEmpties` (a `$node` copy of the preset's `doc`; `$node` has no `extendSchema`). `test/preset-tripwire.test.ts` compares it with the preset's own and fails after a Milkdown upgrade that changes it | |
| 5 | Cells kept edge spaces (the cell writer bypasses the paragraph writer) | Cells hand the normalised paragraph to the preset writer | |
| 6 | Hard break in a table cell (GFM cells are one line) or in a heading (an ATX heading is one line) | Written as inline `<br />`; `htmlBreakIsHardBreak` (`htmlSchema.extendSchema`) reads inline `<br>` / `<br />` back as a hard break. The empty-paragraph placeholder (a `<br />` alone in its paragraph) is folded away by the preset before this runs. Before: a cell break vanished and a heading break became a space. After: `## a<br />b` and `\| a<br />b \|` read back as the same hard break | A space for headings (what it was); a newline (ends the table) |
| 7 | Inline code, emphasis, strong, strike-through and link in any adjacency lost marks or ran delimiters together (`*`x`*two`, `***a**[b](u)***c**`) | Cause: Milkdown replaces mdast-util-to-markdown's `emphasis` and `strong` handlers with simple ones that skip the library's own delimiter ("attention") machinery (it picks `*` or `_` and encodes neighbouring characters). `withoutAttentionHandlers` drops the two overrides; reading always gives the `*` marker (`emphasisStar`, `strongStar`) so `_em_` and `*em*` are the same mark. Price: `_em_` is written `*em*` (invisible). `test/mark-combinations.test.ts`: 4,000 seeded paragraphs of 2 to 4 runs with punctuation, digits and spaces at the edges: 0 failures but one pattern (26 cases, 0.65%, in the recorded run; the test allows under 1%; listed below) | Re-implementing the flanking encoding in our own handler (hand-written escaping); keeping the `marker` attribute in the writer (needs the default handler, which is not reachable) |
| 8 | An ordered list not starting at 1 cannot interrupt a paragraph, also when a quote holds it first (`* a` then `> 3. x` read back as text) | The previous block is written loose (`startsWithLateOrderedList`, the same "would run together" rule) | |
| 10 | A raw `html` inline node at the start of a line, alone on its line or opening a block tag, was written so that it re-parsed as ONE HTML block that swallowed the next lines (`</b>`, a break, `&` came back as a single html node). Also an opened `<pre>`, `<script>`, `<style>` or `<textarea>` alone, which ends only at its closing tag | In a paragraph, list item or quote (not a heading or cell), such a node is written, and in the normal form held, as the same literal text (`\</b>`): both render as the inert text `</b>`, so a reader sees no difference; only the node type changes. A paragraph that is a single html node (a raw HTML block read from Markdown) stays HTML, and the item holding it is written loose (a block runs to a blank line). Inline HTML after text, or an inline tag followed by text (`<b>x</b>`), stays HTML | Escaping with a zero-width prefix (changes the text) |
| 11 | `## ` or the level command inside a table cell was accepted and the level lost on save (a GFM cell is one line of inline content) | The level command and the `#` input rule refuse inside a header or body cell, as on the first block of a task item (`levelCannotBeWritten`). `level-contexts.test.ts` scripts the schema: the node types whose content can hold a paragraph are `doc`, `blockquote`, `list_item`, `footnote_definition`, `table_cell`, `table_header`; each is tested: all write the level except the two cell types and the first block of a task item, which are refused | |
| 12 | Raw HTML opening a construct that ends only at a terminator the node does not hold swallowed the following blocks (`<?php` with no `?>`, `<!--` without `-->`, `<![CDATA[` without `]]>`, `<!DOCTYPE` without `>`, `<pre>` without `</pre>`) | All seven start conditions of CommonMark 0.31 section 4.6 ("HTML blocks") are covered: 1 to 5 by writing the unclosed node as literal text, 6 and 7 (they end at a blank line) by writing the item loose. `html-forms.test.ts`: a test per condition, at the top level and in a tight list item; the blocks after survive | |
| 13 | Raw HTML that is not complete (a half tag, a lone `<!--`, `<?php` after text) is not HTML to the reader (section 6.6, "Raw HTML") and came back as text | Written and held as text in the normal form | |
| 14 | A whole element in one html node (`<aside>n</aside>`) after text, in a heading, a cell or a task item came back as three nodes (open tag, text, close tag) | The normal form splits it the same way; alone in a paragraph, a block element (`<div>x</div>`) stays one node, an inline one splits. The writer gives a task item's first paragraph the same normal form (the reader treats it inline after the checkbox) | |
| 15 | A padded ` <br> ` or doubled `<br><br>` html value was turned into breaks by the reader, not by the normal form | The normal form makes one hard break per `<br>` and trims the padding | |
| 16 | A multi-line raw HTML block read from Markdown that opens with a complete tag alone on its first line (`<a href>` / `<img>` / `</a>`, a `<picture>` block: start condition 7) was written back as escaped text, so images and links were lost and the second save changed the URLs | The "is this a block" test looked at the whole value; it now judges the first line (conditions 1 to 6 by the opening, 7 by a complete tag alone on the line). The protection for a hand-built unclosed node stays (it applies to nodes whose terminator is missing). `html-blocks.test.ts`: 500 generated blocks of all seven kinds, one line and several, followed by a paragraph and a list: byte-identical, the document re-reads identical | |
| 17 | Inline code with spaces at its edges (`  y  `) was saved as `` `y` ``: **text lost** | Cause: the normal form (and so the writer) trimmed the first and last text run of a block whatever its marks, so the code text lost its edge spaces before the library's own code handler (which pads the span when both sides start and end with a space) saw it. Code text is no longer trimmed or moved out of its mark; all-space code (`   `) round-trips. `code-spans.test.ts`: all 3,905 strings of up to 5 characters over backslash, pipe, backtick, space and a letter, in a paragraph and a cell | |
| 18 | A link, emphasis, strong or strike-through over a Shift-Enter hard break was saved as two marks, one per line | A hard break carries the marks that continue across it (the reader gives it the enclosing marks; the editor makes it with none): the normal form sets them, the writer writes the mark once (`[a\` newline `b](u)`), and in a heading or cell the `<br />` sits inside the mark. A link over a soft line break in Markdown stays one link | |
| 19 | Reader: emphasis inside emphasis (`*a **b *c* d** e*`) lost the outer italics for `d` and `e` | The reader, not the writer: marks are a set, and the inner close removed the outer one (`marked` keeps it). A remark transform (`tidyReading`) unwraps an emphasis, strong or strike inside the same mark | |
| 20 | Reader: `* [ ]` with nothing after the checkbox was a bullet with the text `[ ]`, saved `* \[ ]`, while the editor's empty task item is written `* [ ] <br />` | The same transform makes an item whose first paragraph is only the checkbox an empty task item | |
| 21 | Reader: `<br/>` then a newline was two hard breaks (the break element, then one for the newline) | The transform drops the break the newline made, so it is one | |
| 9 | Task checkbox before a heading | **Not expressible**: GFM puts the task marker only in front of the first paragraph (GitHub Flavored Markdown spec, "Task list items (extension)": the marker starts the item's first paragraph), and `* [ ] ## h` is a paragraph whose text is `## h`. Prevented in the editor: `setBlockLevelCommand` and the `#` input rule refuse the first block of a task item (`fixed-losses.test.ts`) | Writing the first block as a level-0 paragraph (changes what the user sees, so it stays a loss) |

### Normalisations (invisible changes only)

The live document keeps its form; the Markdown and `normaliseForMarkdown` have the normal form (`normalisations.test.ts`).

| Change | Why invisible |
|---|---|
| Hard breaks at the start or end of a block are dropped | A break with nothing after it shows nothing |
| Spaces and tabs at the start or end of a block, and beside a hard break, are dropped | HTML collapses them |
| Empty paragraphs at the end of the document are not written | The empty last block is the typing area |
| A space at the edge of a **longer** marked run (`**a **b`) is written outside the marks that start or end there | The run keeps its visible text and marks; only a space beside it loses an emphasis or strong mark, which cannot be seen (17 of the 2,000 wild documents). A run that is only whitespace is a different case: see the Losses table |
| A second hard break in a row, and every hard break in a heading or table cell, read back as `isInline: false` | Both kinds render as a line break |
| A link nested with emphasis, strong or strike-through is written link-outermost: `**[text](url)**` becomes `[**text**](url)` (marks are a set, so the source order is not kept; the writer must put the link outside or a link over differently marked text splits). The reference renderer sees the different nesting, a reader does not; this is why two third-party documents are listed in the corpus exceptions | The same text and look |
| `_em_` and `__strong__` are written `*em*` and `**strong**` (the `marker` attribute is always `*`) | The same mark |
| Inline `<br>` typed in Markdown is read as a hard break (see "Converted on load") | The same line break |
| Incomplete raw HTML becomes text; a whole element in one html node is split into its tags and text; padded or doubled `<br>` values become breaks | The reader sees the same characters and the same line breaks; only the node types differ |
| An html node alone at the start of a line, or opening a block tag, becomes the same literal text (`</b>` stays visible as `</b>`) | Both render as inert text; only the node type differs |
| Markdown side, first save: setext headings become ATX; `---` and `___` become `***`; a bare URL gains angle brackets; a reference-style image is inlined; table cells are padded; `-` bullets become `*` | The same document |

### Losses (a reader can see the change, or the checkbox, text or link is lost)

Counts are documents out of 2,000 (ordinary / wild). Canaries are in `test/known-limits.test.ts` unless noted.

| Loss | Visible effect | How a user reaches it | Ord. / wild | Prevented in the editor? (web client work needed) | Canary |
|---|---|---|---:|---|---|
| Text that looks like a web or email address (`http://x.y`, `www.x.y`, `me@x.com`) is read back as a link | The text becomes clickable; no text is lost | Typing or pasting an address as plain text, then saving: **ordinary users will hit this** | 0 / (addresses mode) | No: it is GFM reading plain text | "text that looks like a web address…", "email-like text…" |
| A task checkbox in front of a heading | The checkbox disappears | Turning the first block of a task item into a heading, or ticking a heading item as a task | 0 / 473 | **Partly:** the level command and the `#` input rule refuse it. The web client must also hide the heading choices (toolbar, menu, shortcuts) on that block and not offer "task" on a heading item. Still refused by the converter if present | "a task checkbox in front of a heading…"; `fixed-losses.test.ts` |
| Inline code with a backslash directly before a pipe, in a table cell (`grep 'a\|b'`) | The backslash is lost (`a|b`) | Putting a regex or shell pattern with `\|` in a code span in a table cell | 0 / 0 (3,900-string cell test: 496 contain it) | No (the web client could warn); the converter refuses the save | "inline code with a backslash right before a pipe…"; `code-spans.test.ts` |
| A run that is **only** whitespace (one space, or several) carrying a link or strike-through, between two letters | The mark is lost (saved as plain `a b`; the normal form says so): a clickable gap or a struck gap disappears (inline code is not in this row: code text is never trimmed and keeps its spaces). Emphasis and strong on such a run are dropped too but nothing can be seen. A tab or a no-break space keeps every mark (written as a character reference or inside the delimiters) | Selecting one space and applying the mark, or deleting the text of a marked run and leaving a space | rare | No. The web client should drop a link, code or strike mark when a selection that is only whitespace would get it (and when a deletion leaves a marked whitespace-only run) | `marked-whitespace.test.ts` (one per mark, one space and several spaces; tab and no-break space survive; inline code keeps its spaces) |
| Two runs with partly overlapping marks and a space between (emphasis+strong, then strong+link) | The marks read back differently | Bold-italic text, a space, then bold link text | 0 / 0 (4,000-case marks test: 26) | No | "two runs with partly overlapping marks…" |
| A newline character inside a text node comes back as a hard break | None under `white-space: pre-wrap`, a break instead of a space under `normal`; the web client's CSS decides | Not by typing (damaged Yjs content only) | wild only | Not needed | `normalisations.test.ts` "a newline inside a text node…" |
| A list written loose where it was tight (empty paragraph before a block, a paragraph after a paragraph, a table, a late ordered list) | Paragraph spacing inside the list | Emptying a list item above a nested list; Enter twice inside an item | most lists with such items | No | `normalisations.test.ts` "an item with an empty paragraph…" |
| A table cell paragraph that already has a level (arriving through Yjs or a paste) | The level is dropped on save | Pasting a heading into a cell; a collaborator's client without the refusal | 0 / 0 | **Built** for typing: the level command and the `#` rule refuse in cells. Web client: paste into a cell must flatten headings | `level-contexts.test.ts` "a cell paragraph that already has a level…" |
| Empty heading at the end of the document | Not written (Yjs keeps it) | Typing `## ` and nothing else at the end | by design | No | "an empty heading at the end…" |
| A link around an image plus other content; a link mark added to an image in the browser | The link is dropped by Yjs | Pasting a linked image with a caption | n/a | The web client must set `href` on the image node, never the link mark | `yjs-losses.test.ts` |
| Bullets use `*` | `- a` becomes `* a` | Imported Markdown | n/a | Not needed | `normalisations.test.ts` |

Fixed (no longer losses): hard break in a table cell, hard break in a heading, inline code touching another
mark, a link between emphasised and strong runs, delimiters next to punctuation, a late ordered list in a quote.

Web and email addresses, investigated: they come from GFM's autolink-literal extension on reading. Tried: the library's
own escapes (`http\://x.y`, `me\@x.com`): still linked; a character reference (`http&#58;//x.y`): still linked, because
the reader's transform runs on the decoded text; a remark plugin that unlinks links the extension created (no source
bracket): works, keeps `<http://x>` and `[t](u)`, but turns every bare URL in imported Markdown into plain text with
`&#58;` references in the saved Markdown. Chosen: keep GFM's behaviour. A typed address becoming clickable is harmless and
no text is lost; losing links in imported documents would not be.

### Second-save drift (Markdown text changes once more, the document is unchanged)

| Class | Minimal example | Ord. / wild / editor-made |
|---|---|---:|
| Blank lines between list items in a quote: the reader does not see the blank line after an item that ends with a nested list | quote > list: item `a` holding a nested list `b`, then a loose item `c`: first save `> * a\n>   * b\n>\n> * c`, second `> * a\n>   * b\n> * c` ("second-save drift 1" and "2") | 8 / 0 / 37 (both classes together for the editor-made set) |
| A tab inside a table cell changes the column padding | a cell holding `\t` | 0 / 0 / counted with the row above |

Both are stable from the second save on. Total full fixed points: 1,992 of 2,000 ordinary documents.

### Converted on load

| Stored | Read as | Why |
|---|---|---|
| A raw `html` node whose value is exactly a bare break (`<br>`, `<br/>`, `<br />`, any case) | A hard break (it showed the literal text before) | Intended: exports from other tools write `<br>`, and a heading or table cell now writes its hard breaks as `<br />`. `normaliseForMarkdown` maps such a node to a hard break, so the normal form agrees with the read-back |

Typed text that spells `<br />` is not converted (it is written `\<br />` and stays text). Canaries: `converted-on-load.test.ts`.

### Inline code in table cells

Cause of the lost backslash: GFM un-escapes `\|` to `|` in a cell before reading inline content, even inside code, and
a pair `\\` before a pipe does not help (`\\|` ends the cell). So `\|` inside a cell code span can only come out as `|`.
Spec: GFM 0.29, "Tables (extension)": a pipe is included "by escaping it, including inside other inline spans"; there
is no other escape. Tried: `\\|` (ends the cell), `\\\|` (reads back as two backslashes and a pipe), two adjacent code
spans (the backtick runs merge). Writing the text without the code mark would keep the characters and lose the
monospace; not done because that changes what the user sees. The 3,900 strings over backslash, pipe, backtick, space and
a letter round-trip in a paragraph (0 failures) and in a cell except those containing a backslash before a pipe
(`code-spans.test.ts`).

### Only reachable with hand-built documents

The editor cannot produce these (a table always has a column; an emptied item keeps its paragraph), so ordinary users do not meet them; a separate generator found them.

| Class | What happens | Canary |
|---|---|---|
| A table with zero columns (empty header row and empty rows), at top level or inside a list item | The writer throws (`Cannot read properties of undefined`), so the converter would report an internal failure. Another construction read it back "as text with hard breaks"; with the shapes that could be built, the throw is what happens | `known-limits.test.ts` "hand-built only: a table with no columns…" |
| A list item holding an empty paragraph followed by another block, nested in a quote or a list: Markdown drifts once on the second save, document unchanged apart from the list spacing flag | **Not reproduced.** Tried: hr, code, quote and list as the following block, item flag on and off, inside a quote and inside a list item (the empty-paragraph rule writes such items loose, and they were stable). The nearest real case is the quote-list-spacing drift above (items ending in a nested list), pinned by "second-save drift 1" and "2" | none beyond those |

### Generator artefacts, checked against the editor

- A table with an **empty header row** can be made in the editor (delete the header text); it is written `|   |   |` and round-trips, stable (`marked-whitespace.test.ts`). Not a loss.
- A **stale list label** (`5.` where the item is number 1) is derived: the reader sets it to `index + start` (the preset's `remarkAddOrderInList`), the editor's `syncListOrderPlugin` to `${index + order}.`. `normaliseForMarkdown` now does the same for every list item (ordered: `${index + order}.`; bullet: `•`; the list type follows the list), so stale, duplicated, missing and non-numeric labels, and a list whose start differs from its first label, give a normal form equal to the read-back (the generator makes 25% of its lists that way).

### Ordered list numbers on screen after concurrent editing (editor behaviour, for the web client)

`list-labels-concurrent.test.ts`, real Yjs sync. Five items, A inserts at position 2 while B deletes item 4 and inserts at the end: both editors converge to the same document, which writes and reads back as its normal form, **but the merged live document is numbered wrongly on both sides**: items 5 and 6 carry the labels `4.` and `5.`, and stay so until someone edits the list, because the preset's renumbering plugin does not run after a remote change. In 200 seeded interleavings of insert, delete and move over ordered, nested and task lists, 42 of the 400 live documents were left with labels out of step (all converge; all save correctly, because the Markdown numbers items by position). What a user sees: a list showing `1. 2. 3. 4. 4. 5.`. The stale label is also **persisted in the live state** and shown to a client that opens the page later, until someone edits the list, so the web client must draw the numbers from position, not from the stored label. The editor should not store the number in the document: draw it from CSS counters or a decoration (or renumber after every remote change; every client would write the same value).

### Audit of `normaliseForMarkdown`: every place it changes or drops a text character

The normal form must never change what the text says. It does not change a non-whitespace character anywhere. The places
that change characters are all whitespace or a break, each judged invisible under ordinary HTML white-space rules (the
editor's own CSS decides for `white-space: pre-wrap`, for the web client):

1. spaces and tabs at the start or end of a text block, and beside a hard break: dropped (CommonMark strips them). **Code text is excluded**: it was trimmed before this pass and that hid the lost code spaces from the converter, which compared against the trimmed form (item 17).
2. a newline character in a text node becomes a hard break (the reader does the same).
3. a hard break at the start or end of a block is dropped; a run of breaks keeps its count (the later ones are `isInline: false`).
4. a whitespace-only text node (paragraph of spaces) becomes empty; a space at the edge of a marked run leaves the marks that start or end there (characters kept).
5. html nodes: padded or doubled `<br>` values become breaks (the padding spaces go); incomplete HTML and HTML at the start of a line that would open a block becomes the same literal text; a whole element splits into tags and text (characters kept).
6. empty paragraphs at the end of the document are dropped; list item labels are renumbered; the emphasis marker is `*`.

### Reader findings from the corpus (Markdown import)

- Nested emphasis: the reader was wrong (fixed, item 19). Compared with `marked` in the corpus entry `proof-finding-nested-emphasis`.
- `* [ ]` empty to-do items: fixed (item 20).
- A quote followed by `7.` list text: **the reader is right** (CommonMark: a list can interrupt a paragraph only if it starts with 1, so the line is a lazy continuation of the quote's paragraph); `marked` differs. Recorded as "reference renderer differs" in the corpus manifest (`proof-fix08-late-ordered-in-quote`).

### Addresses, line endings, trims

| Change | What a reader sees | Where |
|---|---|---|
| **Address allow-list** (`isSafeUrl(value, kind)`, one function). Links: `http`, `https`, `mailto`, `tel`, `sms`, `xmpp`, `irc`, `ircs`, `ftp`, `ftps`, `matrix`, `geo`, and relative references (`/a`, `./a`, `a/b`, `#x`, `?q`, `//host/x`, a bare name). Images: `http`, `https` and relative only (protocol-relative `//host/a.png` counts as relative and is accepted). Refused: any other scheme in any spelling a browser reads as one (`java<TAB>script:`, case changes, entity and percent spellings, invisible characters, leading or trailing spaces), control characters, over 8,192 characters. | A link whose address is refused **keeps its text and loses the link**; an image becomes its **alt text** (nothing if it has none); an image link keeps the image. Never kept live. | parse runners and `toDOM` of link and image; `normaliseForMarkdown` (so a Yjs state that carries any address is cleaned at save time); the converter's seed |
| A line ending in text (LF, CR, CRLF) is one hard break | the same line break | normal form; the Markdown reader reads all three as one line ending. In a code block CR and CRLF become LF (HTML parsers do the same). A lone CR is handled here so that it cannot make every save of the page fail closed |
| Trims are linear scans | none | `/[ \t]+$/` was quadratic on "a" + 100,000 spaces + "x" (18 s at 100 KB) |

Example: `[x](javascript:alert(1))` is stored as `x`. The converter neutralises instead of refusing the save because a Yjs state can carry any address: refusing would stop the page's Markdown from updating. Early refusal caps (delimiters per paragraph, children per block) and line endings are in `docs/proof/m2-conversion.md`; U+2028, U+2029, U+0085, vertical tab and form feed are kept, CR and CRLF in text become a hard break and in code LF.

Raw HTML (`html` nodes) stays inert text in the editor; a future renderer must not run stored Markdown through an HTML-allowing renderer and must set `rel="noopener noreferrer"` on links.

### Browser check

"Two hard breaks keep a visible blank line" is inferred from equal document structure (two hard-break nodes before and
after); it has not been checked in a browser. That check is planned with the web client.

### Why the heading is a paragraph with a level

`test/heading-interleavings.test.ts`: in 200 seeded interleavings of "one editor changes the level of a block while the
other types in it", both sides end with the block as a paragraph at the chosen level, every typed token once and in that
block, and no `heading` node. The control runs the same interleavings against the plain preset (heading as its own node
type): 71 of 200 lose typed text or diverge.

## State size against Markdown size

Reproduce with `bun run test:benchmark` (`packages/editor-schema/test/benchmark/size-ratio.test.ts`; `bun run test` does not
run it). It prints the table below and fails if any ratio differs by more than 5% from the value recorded here. Each
document is generated from a fixed seed (a linear congruential generator, seed 7), parsed by `grimoireEditorPlugins`
and written to the `prosemirror` fragment with y-prosemirror, as the editor's collab plugin does. The state is one
fresh Yjs update (one client, no edit history), so it is a lower bound. The Yjs client id is fixed at 3,000,000,000 in the benchmark, so the sizes are exactly repeatable. This matters: every
item stores ids, and Yjs picks a random 32-bit client id (5 bytes as a varint for 97% of ids). With a small id such as 1
the same documents are about 10 to 25% smaller (prose 10 KB 1.45, tables 10 KB 10.26, mixed 10 KB 4.09), which accounts for most of the gap against a smaller-id measurement. Real clients have large ids, so the 5-byte figures apply.

The ratio depends on the shape, so each shape is defined exactly (a document is as many of these units as reach the size):

| Shape | One unit |
|---|---|
| prose | one paragraph of 40 to 79 words (words from a list of 42) with bold, emphasis and a link; a level-2 heading before every 12th paragraph |
| lists | six bullets each with one nested bullet (depth 2), a 3-item ordered list, 2 task items; a level-3 heading every 6th unit |
| tables | one table, 5 columns, header plus 8 body rows, cells of one or two words |
| code | one TypeScript code block of 22 lines (one `const` and a comment per line) |
| mixed | a level-1 heading, a 25-word paragraph with inline code and bold, a 2-item list, a quote, a 2x2 table, a shell code block |

Other generators will give other ratios (another generator measured about 15% lower, for example prose 1.31 at
10 KB and tables 11.18, partly from the client id above): the figures below hold for these documents only. The pattern holds for any generator: tables
and lists cost many Yjs elements per byte, code and prose few.

| Shape | Size class | Markdown bytes | Yjs state bytes | Ratio |
|---|---|---:|---:|---:|
| prose | 10 KB | 9,865 | 15,697 | 1.59 |
| prose | 100 KB | 102,388 | 164,347 | 1.61 |
| prose | max | 954,087 | 1,535,271 | 1.61 |
| lists | 10 KB | 9,925 | 100,558 | 10.13 |
| lists | 100 KB | 100,413 | 1,056,892 | 10.53 |
| lists | max | 145,549 | 1,534,467 | 10.54 |
| tables | 10 KB | 10,048 | 132,962 | 13.23 |
| tables | 100 KB | 101,635 | 1,384,937 | 13.63 |
| tables | max | 112,441 | 1,531,871 | 13.62 |
| code | 10 KB | 9,779 | 10,362 | 1.06 |
| code | 100 KB | 99,703 | 105,910 | 1.06 |
| code | max | 1,445,118 | 1,535,885 | 1.06 |
| mixed | 10 KB | 10,144 | 51,837 | 5.11 |
| mixed | 100 KB | 101,569 | 533,780 | 5.26 |
| mixed | max | 291,017 | 1,534,093 | 5.27 |

The `max` rows were measured at the state cap of that time (1,536,000 bytes). At the current cap of 1,000,000 bytes the same ratios give about 620 KB of prose, 95 KB of lists, 73 KB of tables, 940 KB of code and 190 KB of mixed Markdown (computed from the ratios, not measured again).

The specification's "about 4x" holds only for mixed documents (about 5x). Per shape the ratio is stable across sizes but
ranges from 1x (code, prose) to 13.6x (tables). The state cap therefore admits (at the current 1,000,000 bytes) about 73 KB of
table-heavy Markdown or 94 KB of list-heavy Markdown, but about 0.9 MB of code: for lists and tables the state cap,
not the 1 MiB Markdown cap, decides. (Measured at the former cap of 1,536,000 bytes: 112 KB, 145 KB and 1.4 MB.)
