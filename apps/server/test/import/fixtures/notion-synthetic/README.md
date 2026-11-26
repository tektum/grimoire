This export is synthetic: invented names and tiny files, constructed from the documented format, from other importers' tests and from the shapes a real export showed in M7-T08 (counted in aggregates, see `docs/proof/m7-real-export.md`); nothing in it comes from that export.

# The synthetic Notion export

`build.ts` builds it in memory as a zip (the hand-written writer of `../../hostile/zip-builder.ts`), with fixed ids, names, bytes, order and zip times, so two builds are byte-identical. Nothing is committed or written to disk.

## What it holds (and `NOTION_CONSTRUCTS` in `build.ts` names the same things)

- ids of 32 hexadecimal characters after a space (`Page <id>.md`) and without one (`Folder<id>/`)
- nested folders, three deep, and a page with children (the page file and a folder of the same name and id)
- two pages with the same title and different ids
- a name of more than 200 bytes
- links the way Notion writes them: percent-encoded relative paths, and plain ones with spaces, with `../`
- an image and files in the page's own folder and in a sibling folder, and a PDF
- `<aside>` with an emoji, `<details><summary>`, a to-do list, a table, a code fence, a `$$` equation, front matter
- a database: the `Name <id>_all.csv` and `Name <id>.csv` files, rows with page files and rows without, and a CSV with a byte order mark
- a nested zip
- the shapes of a real export (M7-T08): a page's folder without an id (`Notes/` beside `Notes <id>.md`); a name cut at 50 characters, and one with an unsafe character replaced by a space, each with its whole title in the `# heading` on its first line; a database exported as `_all.csv` only, linked both as its `_all.csv` and as if it were a page (`Projects <id>.md`, a file the export does not hold); a callout with blank lines inside, a list and a callout nested in it; a row page that only repeats its row, and one with text of its own
- `buildNotionExportInParts`: an export in parts, one zip that holds two part zips, a page of the first using a file of the second

## What was assumed, and what a real export showed

The first six items were assumptions about the export format. M7-T08 checked them against a real export:

1. The 32-character id is lower-case hexadecimal, after a single space in a name, and sometimes glued to the name of a folder. Pages: confirmed. Folders: they have no id at all.
2. A page with children is a `.md` file and a folder of the same base name. Confirmed, the folder without the id.
3. Links to other pages and to attachments are relative to the file that holds them, percent-encoded, and sometimes written with literal spaces. Relative and mostly percent-encoded: confirmed (literal spaces were not counted); a link to a database is written as its `_all.csv` or as if it were a page.
4. A database exports as two CSV files (the `_all` summary and the plain one) and a folder of its row pages; a row without a page has only its CSV line. Differs: only the `_all.csv`.
5. HTML constructs (`<aside>`, `<details>`) are kept inside the Markdown. Confirmed, with blank lines and lists inside, and callouts nested.
6. An export that is too large is split into nested archives. Confirmed: the full export is a zip of its part zips.

The M7-T06 rules are built on both the assumed and the observed shapes, so the fixture keeps both.
