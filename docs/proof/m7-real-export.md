# The import against a real export of Notion (M7-T08)

The owner's own export of a Notion workspace was imported by the engine on a developer machine, to check the rules that M7-T06 built from the export format's documentation and other importers' tests. This page holds aggregates only: no title, folder or file name, text, link or person from the export appears here, and the export never left the owner's private checkout. The scripts that counted are not in the repository, because they read the export.

## The export

- Three zips: the full export (30.67 GB), which is a zip that holds two part zips, and those two parts (18.56 GB and 12.11 GB). 172 pages of the first part use files that are only in the second.
- Inside: 6,305 pages (Markdown), 272 CSV files, 1,578 folders, at most 9 deep. 126 video files make up 32.43 GB of it.
- Each of the three is over the upload limit of 500 MiB (R10.3), so none of them can be imported as it is.
- For the runs below, the two parts were merged into one zip without the video files, which are over the 25 MB attachment cap anyway: 7,323 entries, 257 MB zipped, 292 MB uncompressed.

## The ten things only a real export could show

The M7-T06 contract listed what the constructed rules could not know without a real export. Each is confirmed, differs (the rule was changed to match), or is new to the importer.

| # | What | What the real export shows (aggregates) | Result | Where |
|---|---|---|---|---|
| 1 | The id in a name | Every page file ends in its 32-character id after a space. Folders have no id: a page's folder is `Title/`, beside `Title <id>.md` | Pages confirmed; folders differ | #467: a folder `X/` beside `X <id>.md` holds that page's children. #474 (decision 171): of 11 folders beside several pages of their name (75 pages), 8 go to the one page that links into them |
| 2 | `_all` CSV twins | 271 of the 272 CSV files are a database's `X <id>_all.csv`, with no plain twin; 1 plain CSV has no `_all` one. A page links to a database in two ways: to its `_all.csv` (325 links, all found as written), or as if it were a page, `X <id>.md`, which the export does not hold (206 links). 1 link points at the plain CSV | Differs: no twins, and a database is linked as a page | #472 (decision 112): a database is its `_all.csv`, or a plain CSV with no `_all` one. #469: the 206 links are found by the database's id, as the `_all.csv` carries it. #469 also maps a link to `X <id>.csv` onto its `_all.csv`, for exports that link that way (none here) |
| 3 | Long names cut | 512 file names are cut at 50 characters, while the `# heading` on the page's first line holds the whole title | Confirmed | #473 (decision 169): the title is that heading |
| 4 | Characters replaced | 485 file names have characters replaced; 383 first-line headings differ from their file name | Confirmed | #473 |
| 5 | How links are written | 10,241 links in the 6,305 pages: 2,618 relative (2,416 of them percent-encoded), 192 absolute `notion.so` links, 7,293 other web links, 137 `mailto`. Of the 1,900 relative links to pages, 1,694 match a path as written; the other 206 are links to a database (check 2) | Confirmed, with a fallback | #469: a link whose path does not match is found by the id in its name. A link that matches nothing stays as written and is a warning |
| 6 | Callouts and their icon | 1,166 callouts (`<aside>`) in 337 pages. Every tag is on a line of its own and every callout has blank lines inside; 306 hold a list, 11 are nested in another, 38 are indented in a list item. The first line of text starts with an emoji in 927, is an icon picture (`<img>`) in 23, starts with a link in 9, and is plain text in 207. 6 toggles (`<details>`) | Differs in shape: blank lines, lists, nesting | #470 (decisions 110, 111): a callout is a quote whose first line is bold (an icon picture kept as it is, a line that starts with a link not bold); a toggle is its summary in bold. No `<aside>` is left in the pages written below |
| 7 | Images and attachments | A page's files sit in its folder: 829 images. In the run below, 690 files that pages use are imported, 38 are refused by type, 13 are used by no page, and 6 zips inside the zip are set apart | Confirmed | M7-T04 engine |
| 8 | An export in parts | The full export is a zip of its two part zips, each over 500 MiB, and pages of one part use files of the other | New | #466: a zip with no page and other zips in it fails `nested_or_split_export`, and the import screen says what to do; a file over the limit is told to leave out its big files |
| 9 | A row page's properties | 3,298 pages are a database's rows. After the `# ` title line come `Column: value` lines for the table's columns. In the run below, 2,316 hold nothing else and are left out (`database_row`, the table shows them), and 845 kept row pages sit under their database's page | Confirmed | #472 (decision 167) |
| 10 | The sizes of pages | The ten largest pages are below. 2 pages are over the 128 KiB seed cap (skipped `too_large`), and none is over the state cap | Measured | Below |

## The ten largest pages

From the in-memory run below, by the size of the seeded state. Ranks stand in for page ids, because the ids are those of a run on one machine. The Markdown is the stored, canonical one.

| Rank | Markdown (bytes) | State (bytes) | State bytes per Markdown KB |
|---|---|---|---|
| 1 | 448,514 | 241,746 | 551.9 |
| 2 | 35,662 | 169,547 | 4,868.4 |
| 3 | 130,289 | 166,916 | 1,311.9 |
| 4 | 91,745 | 165,081 | 1,842.5 |
| 5 | 73,758 | 158,616 | 2,202.1 |
| 6 | 111,940 | 151,042 | 1,381.7 |
| 7 | 101,529 | 150,917 | 1,522.1 |
| 8 | 32,364 | 148,998 | 4,714.3 |
| 9 | 46,498 | 143,746 | 3,165.6 |
| 10 | 84,453 | 140,439 | 1,702.8 |

over-cap: 0 (the state cap is 1,000,000 bytes)

## The engine on it

### Both passes in memory, with the Notion rules

Both passes of the engine, the real Markdown converter, the Notion profile (`notion_md_csv`) with every rule of the M7-T06 stack (#465 to #474, at fb7b04d), and in-memory fakes for the store and the file store. The settings are the production defaults (R10.3, R12.30), with no fetcher for pictures from the web.

| What | Result |
|---|---|
| Pages to write (pass one) | 6,701 (the generic profile: 7,017) |
| Pages written | 4,361; the other row pages are left out as above |
| Database pages | 249 tables. 22 databases fail: 21 CSVs that no reader parsed (#471, not in this stack, reads all 21) and 1 table over the caps (`table_too_large`). Each keeps its CSV |
| Titles that still carry an id | 0 |
| Callouts left as HTML | 0 |
| Words of the source kept in the page's text and title | at least 98% on 3,719 pages, 90% to 98% on 222, 50% to 90% on 45, under half on 1 |
| Warnings | 251 |
| Pictures from the web | 39 not copied (copying was off in this run) |
| Time | 64 s |
| Peak memory | 1,219 MB (the whole import in one process with in-memory fakes) |

### The import job on PostgreSQL

The import job end to end on a local PostgreSQL, with the generic profile (`markdown_zip`, main at 473e388, before the Notion rules). Caveat: that PostgreSQL was an embedded PostgreSQL 19 with pgvector 0.8.5, not the PostgreSQL 17 that the project runs, because the run did not use Docker.

| What | Result |
|---|---|
| Killed with `kill -9` after 25 s (1,360 pages written), then started again | The resumed job ended `done`. 7,015 pages ok and 2 `too_large`, none written twice. About 110 s in all |
| Attachments | 955 ok, 38 refused by type, 19 used by no page, 6 zips inside the zip set apart |
| Warnings | 483; 39 pictures from the web not copied |
| Peak memory | 506 MB for the killed process, 466 MB for the resumed one |
| Database size after the import | 91.5 MB |
| Cancelled after 10 s | Stopped at once with 234 pages written. The counts lag by up to one batch: 224 counted |

## What is still open

- None of the three zips can be uploaded as it is: each is over 500 MiB (owner question Q100). An export without its video files fits.
- The 21 database CSVs that no reader parsed are read by #471 (21 of 272 failed before, 0 after).
- The construct counts in the import's report (`report.constructs`) and a second run of the job on PostgreSQL with the Notion profile follow when the M7-T06 stack is on main.
