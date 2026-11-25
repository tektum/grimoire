import { buildZip } from '../../hostile/zip-builder.js';
import type { BuilderEntry } from '../../hostile/zip-builder.js';
import { resolveLinkPath } from '@tektum/grimoire-core/import/paths';

// The synthetic Notion export (M7-T03a): built from the documented export format and from other importers' tests, NOT observed on a real export (see README.md).
// Everything is fixed (ids, names, bytes, order, zip times), so two builds are byte-identical.

const ID = {
  home: '0123456789abcdef0123456789abcdef',
  child: '1123456789abcdef0123456789abcdef',
  grand: '2123456789abcdef0123456789abcdef',
  dupA: '3123456789abcdef0123456789abcdef',
  dupB: '4123456789abcdef0123456789abcdef',
  long: '5123456789abcdef0123456789abcdef',
  media: '6123456789abcdef0123456789abcdef',
  rich: '7123456789abcdef0123456789abcdef',
  fm: '8123456789abcdef0123456789abcdef',
  db: '9123456789abcdef0123456789abcdef',
  row1: 'a123456789abcdef0123456789abcdef',
  row2: 'b123456789abcdef0123456789abcdef',
  nospace: 'c123456789abcdef0123456789abcdef',
} as const;

/** A 1x1 transparent PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const text = (s: string): Buffer => Buffer.from(s, 'utf8');

/** The Markdown files and attachments of the export, by path. Links are the forms Notion writes: percent-encoded relative paths, with the page's own folder name in them. */
function notionFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const home = `Home ${ID.home}`;
  const set = (path: string, content: Buffer | string): void => { files.set(path, typeof content === 'string' ? text(content) : content); };

  // A page with children: the page file, and a folder of the same name and id holding the children (nested folders, three deep).
  set(`${home}.md`, `# Home\n\nStart with [Child page](Home%20${ID.home}/Child%20page%20${ID.child}.md) or the [plain link](Home ${ID.home}/Child page ${ID.child}.md).\n\nSee also [Rich](Rich%20${ID.rich}.md), [Media](Home%20${ID.home}/Media%20${ID.media}.md) and the [database](Tasks%20${ID.db}.csv).\n`);
  set(`${home}/Child page ${ID.child}.md`, `# Child page\n\nBack to [Home](../Home%20${ID.home}.md). Down to [Grandchild](Child%20page%20${ID.child}/Grandchild%20${ID.grand}.md).\n`);
  set(`${home}/Child page ${ID.child}/Grandchild ${ID.grand}.md`, `# Grandchild\n\nA plain \`../\` link: [up](../../Home ${ID.home}.md).\n`);

  // Duplicate titles with different ids.
  set(`Same title ${ID.dupA}.md`, '# Same title\n\nThe first.\n');
  set(`Same title ${ID.dupB}.md`, '# Same title\n\nThe second.\n');

  // A long name (the file system limit of 255 bytes is near), and a folder whose id has no space before it.
  set(`${'Very long title '.repeat(12).trim()} ${ID.long}.md`, '# Very long title\n\nA long name.\n');
  set(`Folder${ID.nospace}/Inside ${ID.nospace}.md`, '# Inside\n\nIn a folder whose id has no space before it.\n');

  // Images and files in sibling folders, and a PDF.
  // The media page is a child of Home, so that `../Assets/` (a sibling folder of Home's) stays inside the archive.
  set(`${home}/Media ${ID.media}.md`, `# Media\n\n![Picture](Media%20${ID.media}/picture.png)\n\n![Sibling](../Assets/other.png)\n\n[The paper](Media%20${ID.media}/paper.pdf)\n\n[A file](Media ${ID.media}/notes.txt)\n`);
  set(`${home}/Media ${ID.media}/picture.png`, PNG);
  set(`${home}/Media ${ID.media}/paper.pdf`, PDF);
  set(`${home}/Media ${ID.media}/notes.txt`, 'plain notes\n');
  set('Assets/other.png', PNG);

  // Constructs Notion exports as HTML inside Markdown, and the Markdown extensions.
  set(`Rich ${ID.rich}.md`, [
    '# Rich', '',
    '<aside>', '\ud83d\udca1 **Tip.** An aside with an emoji.', '</aside>', '',
    '<details>', '<summary>More</summary>', '', 'Hidden text.', '', '</details>', '',
    '- [x] done item', '- [ ] open item', '',
    '| Name | Count |', '| --- | --- |', '| apples | 3 |', '| pears | 5 |', '',
    '```ts', 'const x = 1;', '```', '',
    '$$', 'e^{i\\pi} + 1 = 0', '$$', '',
    '',
  ].join('\n'));
  set(`Front ${ID.fm}.md`, '---\ntitle: With front matter\ntags: [a, b]\n---\n\n# With front matter\n\nBody.\n');

  // A database: the rows' summary (`X <id>_all.csv`) and the database's own (`X <id>.csv`), rows with page files and rows without; a CSV with a BOM.
  set(`Tasks ${ID.db}_all.csv`, `\ufeffName,Status\n"Write the plan",Done\n"Review it",Open\n"Draft idea",Open\n`); // "Draft idea" has no page file
  set(`Tasks ${ID.db}.csv`, 'Name,Status\n"Write the plan",Done\n"Review it",Open\n"Draft idea",Open\n');
  set(`Tasks/Write the plan ${ID.row1}.md`, '# Write the plan\n\nStatus: Done\n');
  set(`Tasks/Review it ${ID.row2}.md`, '# Review it\n\nStatus: Open\n');

  // A nested archive.
  set('Extras ' + 'd'.repeat(32) + '.zip', buildZip([{ name: 'inner.md', data: text('# Inner\n') }]));
  return files;
}

const entry = (path: string, data: Buffer): BuilderEntry => ({ name: path, data, method: /\.(png|pdf|zip)$/.test(path) ? 'stored' : 'deflate' });

/** The export as a zip: the files in path order, so the bytes do not depend on how the map was filled. */
export function buildNotionExport(): Buffer {
  return buildZip([...notionFiles().entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, data]) => entry(path, data)));
}

/** What the export contains, named, with how to tell. The test fails on a construct that is missing, and the README lists the same names. */
export const NOTION_CONSTRUCTS: readonly { readonly name: string; readonly present: (files: ReadonlyMap<string, Buffer>) => boolean }[] = [
  { name: 'id of 32 hex characters after a space', present: (f) => [...f.keys()].some((p) => / [0-9a-f]{32}\.md$/.test(p)) },
  { name: 'id of 32 hex characters without a space', present: (f) => [...f.keys()].some((p) => /Folder[0-9a-f]{32}\//.test(p)) },
  { name: 'nested folders', present: (f) => [...f.keys()].some((p) => p.split('/').length >= 3) },
  { name: 'a page with children', present: (f) => f.has(`Home ${ID.home}.md`) && [...f.keys()].some((p) => p.startsWith(`Home ${ID.home}/`)) },
  { name: 'duplicate titles with different ids', present: (f) => f.has(`Same title ${ID.dupA}.md`) && f.has(`Same title ${ID.dupB}.md`) },
  { name: 'a long name', present: (f) => [...f.keys()].some((p) => Buffer.byteLength(p.split('/').at(-1) ?? '') > 200) },
  { name: 'a URL-encoded link', present: (f) => [...f.values()].some((v) => /\]\([^)\s]*%20[^)\s]*\)/.test(v.toString())) },
  { name: 'a plain link with ../', present: (f) => [...f.values()].some((v) => /\]\(\.\.\/[^)%]* [^)]*\)/.test(v.toString())) },
  {
    name: 'images and files in sibling folders',
    // a `../` link to a file that is in the archive (not one above its root), and a file in the page's own folder
    present: (f) => [...f.entries()].some(([path, v]) => [...v.toString().matchAll(/!\[[^\]]*\]\((\.\.\/[^)]+)\)/g)].some((m) => f.has(resolveLinkPath(m[1] as string, path) ?? '\0'))) && f.has(`Home ${ID.home}/Media ${ID.media}/notes.txt`),
  },
  { name: 'a PDF', present: (f) => [...f.keys()].some((p) => p.endsWith('.pdf')) },
  { name: 'an aside with an emoji', present: (f) => [...f.values()].some((v) => v.toString().includes('<aside>\n\ud83d\udca1')) },
  { name: 'details and summary', present: (f) => [...f.values()].some((v) => v.toString().includes('<details>\n<summary>')) },
  { name: 'a to-do list', present: (f) => [...f.values()].some((v) => /^- \[x\] /m.test(v.toString()) && /^- \[ \] /m.test(v.toString())) },
  { name: 'a table', present: (f) => [...f.values()].some((v) => /^\| --- \| --- \|$/m.test(v.toString())) },
  { name: 'a code fence', present: (f) => [...f.values()].some((v) => v.toString().includes('```ts')) },
  { name: 'a $$ equation', present: (f) => [...f.values()].some((v) => /^\$\$$/m.test(v.toString())) },
  { name: 'front matter', present: (f) => [...f.values()].some((v) => v.toString().startsWith('---\n')) },
  { name: 'a database summary csv (_all.csv)', present: (f) => [...f.keys()].some((p) => /_all\.csv$/.test(p)) },
  { name: 'a database csv', present: (f) => [...f.keys()].some((p) => /[0-9a-f]{32}\.csv$/.test(p)) },
  {
    name: 'database rows with page files and rows without',
    // some row of the CSV has a page file under Tasks/, and some row has none
    present: (f) => {
      const csv = [...f.entries()].find(([p]) => /[0-9a-f]{32}\.csv$/.test(p))?.[1].toString() ?? '';
      const rows = csv.split('\n').slice(1).filter((l) => l !== '').map((l) => /^"([^"]*)"/.exec(l)?.[1] ?? '');
      const hasPage = (row: string): boolean => [...f.keys()].some((p) => p.startsWith(`Tasks/${row} `));
      return rows.some(hasPage) && rows.some((r) => !hasPage(r));
    },
  },
  { name: 'a csv with a BOM', present: (f) => [...f.entries()].some(([p, v]) => p.endsWith('.csv') && v.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) },
  { name: 'a nested zip', present: (f) => [...f.keys()].some((p) => p.endsWith('.zip')) },
];

/** The files of the export (for the test, which checks the constructs against them). */
export const notionExportFiles = notionFiles;

// ---- the plain Markdown archive for the generic profile ----

const SECTIONS = ['alpha', 'beta', 'gamma'] as const;

/** Folders (3 levels), relative links, images, and a link that matches nothing. */
export function plainMarkdownFiles(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  files.set('index.md', text(`# Index\n\n${SECTIONS.map((s) => `- [${s}](${s}/index.md)`).join('\n')}\n\nA link that matches nothing: [gone](missing/nowhere.md)\n`));
  let image = 0;
  for (const [si, section] of SECTIONS.entries()) {
    const pages = [1, 2, 3].map((n) => `page-${String(n)}`);
    files.set(`${section}/index.md`, text(`# ${section}\n\n${pages.map((p) => `- [${p}](./${p}.md)`).join('\n')}\n\nSee [next section](../${SECTIONS[(si + 1) % 3] ?? 'alpha'}/index.md).\n`));
    for (const p of pages) files.set(`${section}/${p}.md`, text(`# ${section} ${p}\n\nA page.\n${image < 5 && p === 'page-1' ? `\n![picture ${String(image)}](img/pic${String(image)}.png)\n` : ''}`));
    { files.set(`${section}/img/pic${String(image)}.png`, PNG); image++; }
    for (const sub of ['one', 'two']) {
      files.set(`${section}/${sub}/index.md`, text(`# ${section} ${sub}\n\nUp: [${section}](../index.md)\n`));
      for (const p of pages) files.set(`${section}/${sub}/${p}.md`, text(`# ${section} ${sub} ${p}\n\nDeep page, with a [sibling](./${pages[0] ?? 'page-1'}.md).\n`));
    }
  }
  // Two more images at the top, so there are five in all.
  files.set('img/pic3.png', PNG); files.set('img/pic4.png', PNG);
  files.set('index.md', text(`${files.get('index.md')?.toString() ?? ''}\n![top](img/pic3.png) ![top two](img/pic4.png)\n`));
  return files;
}

export function buildPlainMarkdownExport(): Buffer {
  return buildZip([...plainMarkdownFiles().entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, data]) => entry(path, data)));
}
