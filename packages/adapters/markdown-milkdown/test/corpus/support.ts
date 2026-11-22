import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { marked } from 'marked';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { expect } from 'vitest';
import type { ConvertResult, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { FRAGMENT_NAME } from '@tektum/grimoire-editor-schema';
import { convertInProcess, convertWith } from '../../src/convert.js';
import { seedInProcess } from '../../src/seed.js';
import { createHeadless } from '../../src/headless.js';
import type { Headless } from '../../src/headless.js';

export const CORPUS_DIR = fileURLToPath(new URL('./', import.meta.url));
export const EXPECTED_DIR = join(CORPUS_DIR, 'expected');

/** Regeneration is deliberate: only this variable, set to exactly "1", ever writes an expected file. */
export const UPDATE = process.env['CORPUS_UPDATE'] === '1';

export const GROUPS = ['real', 'gfm', 'commonmark', 'wiki', 'proof', 'import-shapes'] as const;
export type Group = (typeof GROUPS)[number];

/** What the manifest may say about an entry (only for own entries; real and gfm use known-exceptions.json). */
export interface Annotation {
  note: string;
  /** Second-save drift class named in the proof notes: the second pass differs once, the third equals the second. */
  drift?: string;
  /** A difference between marked's reading of the input and of the output that this entry names and expects. */
  markedDiff?: string;
  /** Behaviour that looks wrong or surprising: kept honest, never hidden by changing the expected output. */
  finding?: string;
}

export interface Entry {
  group: Group;
  name: string;
  markdown: string;
  annotation: Annotation | undefined;
}

export interface Pipeline {
  seed(markdown: string): Promise<SeedResult>;
  convert(state: Uint8Array): Promise<ConvertResult>;
}

/** The converter and seeder exactly as the server uses them. */
export const sharedPipeline: Pipeline = { seed: (markdown) => seedInProcess(markdown), convert: (state) => convertInProcess(state) };

/** The same steps on any headless context (the substitute test builds one from other plugins). */
export function pipelineOn(headless: Headless): Pipeline {
  return {
    seed: (markdown) => {
      const doc = new Y.Doc();
      prosemirrorToYXmlFragment(headless.parse(markdown), doc.getXmlFragment(FRAGMENT_NAME));
      return Promise.resolve({ ok: true, state: Y.encodeStateAsUpdate(doc) });
    },
    convert: (state) => convertWith(() => Promise.resolve(headless), state),
  };
}

export { createHeadless };

/** One save: Markdown -> document -> Yjs state -> converter. */
export interface Pass {
  outcome: string;
  markdown?: string;
  text?: string;
}

export async function runPass(pipeline: Pipeline, markdown: string): Promise<Pass> {
  const seeded = await pipeline.seed(markdown);
  if (!seeded.ok) return { outcome: `seed-refused ${seeded.reason}: ${seeded.detail}` };
  const converted = await pipeline.convert(seeded.state);
  if (!converted.ok) return { outcome: `refused ${converted.reason}: ${converted.detail}` };
  return { outcome: 'converted', markdown: converted.markdown, text: converted.text };
}

export interface Observed {
  first: Pass;
  second?: Pass;
  third?: Pass;
  /** The converter output of the second pass equals the first. */
  stable: boolean;
}

export async function observe(pipeline: Pipeline, markdown: string): Promise<Observed> {
  const first = await runPass(pipeline, markdown);
  if (first.markdown === undefined) return { first, stable: false };
  const second = await runPass(pipeline, first.markdown);
  if (second.markdown === first.markdown) return { first, second, stable: true };
  const third = second.markdown === undefined ? undefined : await runPass(pipeline, second.markdown);
  return { first, second, ...(third === undefined ? {} : { third }), stable: false };
}

/** The files an entry is compared with, by suffix. Refused entries have an outcome file only. */
export function expectedFiles(observed: Observed, withMarked: string | undefined): Record<string, string> {
  const files: Record<string, string> = {};
  const { first, second, third } = observed;
  const secondLine = first.markdown === undefined ? 'second-pass: not run' : observed.stable ? 'second-pass: identical' : `second-pass: differs${third?.markdown !== undefined && third.markdown === second?.markdown ? ', third equals second' : ', NOT stable on a third pass'}`;
  files['outcome.txt'] = `${first.outcome}\n${secondLine}\n`;
  if (first.markdown !== undefined) {
    files['out.md'] = first.markdown;
    files['search.txt'] = `${first.text ?? ''}\n`;
  }
  if (!observed.stable && second?.markdown !== undefined) files['second.md'] = second.markdown;
  if (withMarked !== undefined) files['marked.txt'] = withMarked;
  return files;
}

const readIfThere = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/**
 * Compares one observed file with the committed one. A missing or different file fails with the runner's own diff;
 * nothing is written here. `read` is a parameter so a test can show that a changed output fails.
 */
export function assertMatches(path: string, actual: string, read: (path: string) => string | undefined = readIfThere): void {
  const expected = read(path);
  expect(expected, `missing expected file ${path}: review the output, then regenerate with CORPUS_UPDATE=1`).not.toBeUndefined();
  expect(actual, `${path} differs: if the change is wanted, regenerate with CORPUS_UPDATE=1 and review the diff`).toBe(expected);
}

/** The explicit regeneration step: replaces the whole expected tree. Only called when `UPDATE` is set. */
export function writeExpected(all: ReadonlyMap<string, Record<string, string>>): void {
  rmSync(EXPECTED_DIR, { recursive: true, force: true });
  for (const [key, files] of all) {
    for (const [suffix, content] of Object.entries(files)) {
      const path = join(EXPECTED_DIR, `${key}.${suffix}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
}

/** Every file under the expected tree, relative, sorted: to find files no entry owns any more. */
export function listExpected(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else out.push(full.slice(EXPECTED_DIR.length + 1));
    }
  };
  if (existsSync(EXPECTED_DIR)) walk(EXPECTED_DIR);
  return out.sort();
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Entries: real and gfm from their folders, the others from `own/<group>` with `own/manifest.json`. */
export function loadEntries(): Entry[] {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, 'own', 'manifest.json'), 'utf8')) as Record<string, Annotation>;
  const entries: Entry[] = [];
  for (const group of GROUPS) {
    const dir = group === 'real' || group === 'gfm' ? join(CORPUS_DIR, group) : join(CORPUS_DIR, 'own', group);
    if (!existsSync(dir)) continue; // the `real` group is not distributed (owner decision pending)
    const files = readdirSync(dir).filter((file) => file.endsWith('.md')).sort();
    for (const file of files) {
      const name = file.replace(/\.md$/, '');
      entries.push({ group, name, markdown: readFileSync(join(dir, file), 'utf8'), annotation: manifest[`${group}/${name}`] });
    }
  }
  return entries;
}

// ---- The independent reference: marked, then a canonical form of the HTML it produced -------------------------------

/** Attributes that carry meaning. Everything else (ids, classes other than code language, style, data-*) is ignored. */
const KEEP_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'start', 'align', 'checked', 'type', 'colspan', 'rowspan', 'open']);

interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  attributes?: ArrayLike<{ name: string; value: string }>;
}

const BLOCK_WRAPPERS = new Set(['P']);

/**
 * One line per element start and per text run. Compared: element names and nesting, kept attributes, the text with
 * whitespace collapsed, code text verbatim (trailing line break aside), comments. Ignored: how neighbouring runs of the same mark are split, a `<p>` directly inside
 * `<li>` (tight against loose lists: spacing only), whitespace between blocks, soft line breaks (they render as
 * whitespace), attributes not in the kept set, the `language-` class on code (kept) against other classes (dropped).
 */
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'code', 'del', 'em', 'i', 'img', 'kbd', 'mark', 's', 'span', 'strong', 'sub', 'sup', 'u', 'input']);
function canonicalise(node: DomNode, depth: number, inCode: boolean, out: string[]): void {
  const pad = '  '.repeat(depth);
  // An edge is a block element or a comment (neither shows a space next to it).
  const isBlock = (n: DomNode | null | undefined): boolean => n !== null && n !== undefined && n.nodeType !== 3 && !(n.nodeType === 1 && INLINE_TAGS.has(n.nodeName.toLowerCase()));
  // Runs of whitespace collapse to one space. A space at the edge of a text node is kept when inline content (text, a mark, a link, a code span)
  // sits on that side (a line break counts as an edge: a space next to it is not visible), because "a <em>b</em>" and "a<em>b</em>" read differently; at a block edge it is trimmed.
  const pushText = (raw: string, previous: DomNode | null | undefined, next: DomNode | null | undefined): void => {
    // Code text is kept exactly, even when it is only spaces (one space and two spaces are different code). Elsewhere only ASCII whitespace collapses: a
    // non-breaking space is content, not a space.
    if (inCode) { if (raw !== '') out.push(`${pad}"${raw}"`); return; }
    const collapsed = raw.replace(/[ \t\n\r\f]+/g, ' ');
    const trimmed = collapsed.replace(/^ | $/g, '');
    if (trimmed === '') {
      // Whitespace only: it matters only between two inline neighbours.
      if (previous && next && !isBlock(previous) && !isBlock(next)) out.push(`${pad}" "`);
      return;
    }
    const lead = collapsed.startsWith(' ') && previous && !isBlock(previous) ? ' ' : '';
    const trail = collapsed.endsWith(' ') && next && !isBlock(next) ? ' ' : '';
    out.push(`${pad}"${lead}${trimmed}${trail}"`);
  };
  const children = Array.from(node.childNodes);
  for (const [index, child] of children.entries()) {
    if (child.nodeType === 3) {
      pushText(child.textContent ?? '', children[index - 1], children[index + 1]);
    } else if (child.nodeType === 8) {
      out.push(`${pad}<!--${(child.textContent ?? '').replace(/\s+/g, ' ').trim()}-->`);
    } else if (child.nodeType === 1) {
      const tag = child.nodeName.toLowerCase();
      if (BLOCK_WRAPPERS.has(child.nodeName) && node.nodeName === 'LI') {
        canonicalise(child, depth, inCode, out);
        continue;
      }
      const attributes = Array.from(child.attributes ?? [])
        .filter((attribute) => KEEP_ATTRIBUTES.has(attribute.name) || (tag === 'code' && attribute.name === 'class' && attribute.value.startsWith('language-')))
        .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
        .sort();
      out.push(`${pad}<${[tag, ...attributes].join(' ')}>`);
      canonicalise(child, depth + 1, inCode || tag === 'code' || tag === 'pre', out);
    }
  }
}

const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true } });

interface MutableNode extends DomNode {
  nextSibling: MutableNode | null;
  firstChild: MutableNode | null;
  parentNode: { removeChild(child: MutableNode): void } | null;
  appendChild(child: MutableNode): void;
}

/** ProseMirror merges neighbouring runs with the same mark, so `*a*` `*b*` side by side and one `*ab*` are the same page. */
function mergeAdjacentMarks(node: MutableNode): void {
  for (const child of Array.from(node.childNodes) as MutableNode[]) {
    if (child.nodeType !== 1) continue;
    while (['EM', 'STRONG', 'DEL'].includes(child.nodeName) && child.nextSibling?.nodeName === child.nodeName && child.nextSibling.nodeType === 1) {
      const sibling = child.nextSibling;
      while (sibling.firstChild !== null) child.appendChild(sibling.firstChild);
      sibling.parentNode?.removeChild(sibling);
    }
    mergeAdjacentMarks(child);
  }
}

/** Markdown -> marked -> HTML -> canonical lines. */
export function referenceForm(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  window.document.body.innerHTML = html;
  mergeAdjacentMarks(window.document.body as unknown as MutableNode);
  window.document.body.normalize();
  const out: string[] = [];
  canonicalise(window.document.body as unknown as DomNode, 0, false, out);
  return `${out.join('\n')}\n`;
}

/** Both forms in one file, for entries whose difference is named: the file shows exactly what differs. */
export function markedDifference(input: string, output: string): string | undefined {
  const a = referenceForm(input);
  const b = referenceForm(output);
  return a === b ? undefined : `--- marked, input Markdown\n${a}--- marked, output Markdown\n${b}`;
}
