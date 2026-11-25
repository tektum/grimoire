This export is constructed from the documented format and from other importers' tests, and is not observed: no real Notion export was used to make it (the real one is checked by M7-T08, when the owner provides it).

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

## What was assumed

Each item above is an assumption about the export format, not an observation:

1. The 32-character id is lower-case hexadecimal, after a single space in a name, and sometimes glued to the name of a folder.
2. A page with children is a `.md` file and a folder of the same base name.
3. Links to other pages and to attachments are relative to the file that holds them, percent-encoded, and sometimes written with literal spaces.
4. A database exports as two CSV files (the `_all` summary and the plain one) and a folder of its row pages; a row without a page has only its CSV line.
5. HTML constructs (`<aside>`, `<details>`) are kept inside the Markdown.
6. An export that is too large is split into nested archives.

M7-T06 builds its rules on this fixture; M7-T08 replaces the assumptions that turn out to be wrong with what the real export shows.
