// One benchmark step in its own process, so memory numbers are not polluted by other steps.
// Modes: `build <shape|blocks> <bytes|count> <file>` writes the Yjs state; `convert <file>` converts it and prints JSON;
// `shrink <bytes>` measures the state size after deleting 90% of a page.
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';
import { convertInProcess, seedInProcess } from '../../dist/index.js';
import { compareDocuments, guardState } from '../../dist/guards.js';
import { normaliseForMarkdown } from '@tektum/grimoire-editor-schema';
import { getHeadless } from '../../dist/headless.js';
import { generateBlocks, generateMarkdown } from '../../dist/testing/generate.js';

const BIG = { maxStateBytes: 2 ** 31, maxBlocks: 2 ** 31, maxDepth: 100, maxSeedMarkdownBytes: 2 ** 31, maxSeedLines: 2 ** 31, maxSeedLineMarkers: 2 ** 31, maxReseedMarkdownBytes: 2 ** 31, maxReseedLineMarkers: 2 ** 31 };
const mb = (bytes) => Math.round(bytes / 1024 / 1024);
const [mode, ...args] = process.argv.slice(2);

if (mode === 'build') {
  const [shape, size, file] = args;
  const markdown = shape === 'blocks' ? generateBlocks(Number(size)) : generateMarkdown(shape, Number(size));
  const seeded = await seedInProcess(markdown, BIG);
  if (!seeded.ok) throw new Error(`${seeded.reason}: ${seeded.detail}`);
  writeFileSync(file, seeded.state);
  console.log(JSON.stringify({ markdownBytes: Buffer.byteLength(markdown), stateBytes: seeded.state.byteLength }));
} else if (mode === 'convert') {
  const state = new Uint8Array(readFileSync(args[0]));
  // Static imports are done by now: the time since the process started is node's start-up plus loading the modules.
  const importMs = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const t1 = performance.now();
  const headless = await getHeadless();
  const contextMs = performance.now() - t1;
  const rssIdle = process.memoryUsage().rss;

  // Stages, each timed: what convertInProcess does, step by step (it is monolithic, so they are repeated here).
  const a = performance.now();
  const guarded = guardState(state, BIG);
  const applyMs = performance.now() - a;
  if (!guarded.ok) throw new Error(`${guarded.reason}`);
  const b = performance.now();
  const doc = yXmlFragmentToProseMirrorRootNode(guarded.fragment, headless.schema);
  const toDocMs = performance.now() - b;
  const n = performance.now();
  const written = normaliseForMarkdown(doc);
  const normaliseMs = performance.now() - n;
  const c = performance.now();
  const markdown = headless.serialize(written);
  const serializeMs = performance.now() - c;
  const v = performance.now();
  const back = headless.parse(markdown);
  const parseMs = performance.now() - v;
  const w = performance.now();
  const same = compareDocuments(written.toJSON(), back.toJSON()) === undefined;
  const compareMs = performance.now() - w;
  const verifyMs = parseMs + compareMs;
  const d = performance.now();
  const text = written.textBetween(0, written.content.size, '\n', () => '');
  const textMs = performance.now() - d;
  const e = performance.now();
  const full = await convertInProcess(state, { ...BIG, verifyRoundTrip: false });
  const fullMs = performance.now() - e;
  const f = performance.now();
  const fullVerified = await convertInProcess(state, BIG);
  const fullVerifiedMs = performance.now() - f;
  if (!full.ok) throw new Error(`${full.reason}: ${full.detail}`);
  console.log(
    JSON.stringify({
      stateBytes: state.byteLength,
      markdownBytes: Buffer.byteLength(markdown),
      textBytes: Buffer.byteLength(text),
      importMs, contextMs, rssIdleMb: mb(rssIdle), rssBeforeMb: mb(rssBefore),
      applyMs, toDocMs, normaliseMs, serializeMs, parseMs, compareMs, verifyMs, fixedPoint: same, textMs,
      stagesTotalMs: applyMs + toDocMs + normaliseMs + serializeMs + verifyMs + textMs,
      convertInProcessMs: fullMs, convertVerifiedMs: fullVerifiedMs, verifiedResult: fullVerified.ok ? 'ok' : fullVerified.reason,
      peakRssMb: mb(process.resourceUsage().maxRSS * 1024),
    }),
  );
} else if (mode === 'shrink') {
  const markdown = generateMarkdown('prose', Number(args[0]));
  const seeded = await seedInProcess(markdown, BIG);
  if (!seeded.ok) throw new Error(seeded.reason);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, seeded.state);
  const fragment = doc.getXmlFragment('prosemirror');
  const before = Y.encodeStateAsUpdate(doc).byteLength;
  const count = fragment.length;
  doc.transact(() => fragment.delete(Math.floor(count / 10), count - Math.floor(count / 10)));
  const after = Y.encodeStateAsUpdate(doc).byteLength;
  const converted = await convertInProcess(Y.encodeStateAsUpdate(doc), BIG);
  console.log(JSON.stringify({ blocksBefore: count, blocksAfter: fragment.length, stateBefore: before, stateAfter: after, ratio: after / before, markdownBytesAfter: converted.ok ? Buffer.byteLength(converted.markdown) : -1 }));
} else {
  throw new Error(`unknown mode ${mode}`);
}
