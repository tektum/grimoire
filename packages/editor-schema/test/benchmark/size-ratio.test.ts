/**
 * Benchmark (project `benchmark`, `bun run test:benchmark`; never part of `bun run test`): ratio of Yjs state size to
 * Markdown size for five document shapes at about 10 KB, 100 KB and the largest document whose state fits under the
 * 1,536,000-byte cap. Documents are generated from a fixed seed, parsed by the shared plugin array and written to a
 * Yjs fragment by y-prosemirror, which is what the editor's collab plugin does. Each ratio must stay within 5% of the
 * value recorded in docs/proof/m2-schema-fixes.md.
 */
import { expect, it } from "vitest";
import * as Y from "yjs";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { FRAGMENT_NAME } from "../../src/index.js";
import { makeEditor } from "../helpers.js";

const STATE_CAP = 1_536_000;
const TOLERANCE = 0.05;

const WORDS = "the quick brown fox jumps over lazy dog while server converts live state into canonical markdown for every page document editor schema paragraph heading table cell list item review draft publish team notes meeting agenda budget quarter roadmap customer feedback release incident".split(" ");

/** Linear congruential generator: the same sequence on every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

type Unit = (next: () => number, index: number) => string;
const word = (next: () => number): string => WORDS[Math.floor(next() * WORDS.length)] ?? "";

/** One unit of each shape; a document is units 0..n-1 joined. See the proof note for the plain-language description. */
const SHAPES: Record<string, Unit> = {
  // A paragraph of 40 to 79 words with bold, emphasis and a link; a level-2 heading before every 12th paragraph.
  prose: (next, i) =>
    `${i % 12 === 0 ? `## Section ${i}\n\n` : ""}${Array.from({ length: 40 + Math.floor(next() * 40) }, () => word(next)).join(" ")}. **bold ${i}** and _em_ and [link](https://example.com/${i}).\n\n`,
  // Six two-line bullets (one nested level), a three-item ordered list, two task items; a level-3 heading every 6th unit.
  lists: (next, i) =>
    `${i % 6 === 0 ? `### List ${i}\n\n` : ""}${Array.from({ length: 6 }, (_, k) => `- item ${k} ${word(next)} ${word(next)}\n  - nested ${word(next)}\n`).join("")}\n1. first ${i}\n2. second\n3. third\n\n- [ ] todo ${i}\n- [x] done\n\n`,
  // A table of 5 columns, a header and 8 body rows, cells of one to two words.
  tables: (next, i) =>
    `| id | name | owner | status | notes |\n| - | - | - | - | - |\n${Array.from({ length: 8 }, (_, k) => `| ${i * 8 + k} | ${word(next)} | ${word(next)} | ${next() < 0.5 ? "open" : "done"} | ${word(next)} ${word(next)} |`).join("\n")}\n\n`,
  // A TypeScript code block of a 22-line function with a random constant and a comment word per line.
  code: (next, i) =>
    `\`\`\`ts\nexport function fn${i}(a: number, b: number): number {\n${Array.from({ length: 20 }, (_, k) => `  const v${k} = a * ${k} + b - ${Math.floor(next() * 1000)}; // ${word(next)}`).join("\n")}\n  return v0;\n}\n\`\`\`\n\n`,
  // Heading 1, a 25-word paragraph with code and bold, a two-item list, a quote, a 2x2 table, a shell code block.
  mixed: (next, i) =>
    `# Doc part ${i}\n\n${Array.from({ length: 25 }, () => word(next)).join(" ")} with \`code\` and **bold**.\n\n- a ${i}\n- b\n\n> quote ${word(next)}\n\n| a | b |\n| - | - |\n| ${i} | ${word(next)} |\n\n\`\`\`sh\necho ${i}\n\`\`\`\n\n`,
};

/** Recorded in docs/proof/m2-schema-fixes.md. */
const EXPECTED: Record<string, [number, number, number]> = {
  prose: [1.59, 1.61, 1.61],
  lists: [10.13, 10.53, 10.54],
  tables: [13.23, 13.63, 13.62],
  code: [1.06, 1.06, 1.06],
  mixed: [5.11, 5.26, 5.27],
};

it("state to Markdown size ratios match the proof note", async () => {
  const editor = await makeEditor({ markdown: "x\n" });
  const measure = (shape: string, units: number): { markdown: number; state: number } => {
    const next = random(7);
    const unit = SHAPES[shape];
    if (!unit) throw new Error(shape);
    let markdown = "";
    for (let i = 0; i < units; i++) markdown += unit(next, i);
    const ydoc = new Y.Doc();
    ydoc.clientID = 3_000_000_000; // Yjs picks a random uint32 (5-byte varint for 97% of ids) and every item stores ids: a fixed typical one makes the size repeatable
    prosemirrorToYXmlFragment(editor.parse(markdown), ydoc.getXmlFragment(FRAGMENT_NAME));
    return { markdown: Buffer.byteLength(markdown), state: Y.encodeStateAsUpdate(ydoc).byteLength };
  };

  const rows: string[] = ["| Shape | Size class | Markdown bytes | Yjs state bytes | Ratio |", "|---|---|---:|---:|---:|"];
  const failures: string[] = [];
  for (const shape of Object.keys(SHAPES)) {
    const probe = measure(shape, 20);
    const perUnit = probe.markdown / 20;
    const sizes: [string, { markdown: number; state: number }][] = [];
    for (const target of [10_000, 100_000]) sizes.push([`${target / 1000} KB`, measure(shape, Math.max(1, Math.round(target / perUnit)))]);
    // Largest unit count whose state fits: scale by the cap, step down (or up) until the last fitting and the first overflowing count are
    // known, then bisect between them, so the recorded row is exactly the largest that fits.
    let units = Math.round((100_000 / perUnit) * (STATE_CAP / (sizes[1]?.[1].state ?? STATE_CAP)));
    const step = Math.max(1, Math.ceil(units / 500));
    let fit = units;
    let max = measure(shape, fit);
    let over = fit;
    if (max.state > STATE_CAP) {
      while (max.state > STATE_CAP) {
        over = fit;
        fit -= step;
        max = measure(shape, fit);
      }
    } else {
      over = fit + step;
      while (measure(shape, over).state <= STATE_CAP) {
        fit = over;
        max = measure(shape, fit);
        over = fit + step;
      }
    }
    while (over - fit > 1) {
      const middle = Math.floor((fit + over) / 2);
      const candidate = measure(shape, middle);
      if (candidate.state <= STATE_CAP) {
        fit = middle;
        max = candidate;
      } else over = middle;
    }
    units = fit;
    expect(measure(shape, units + 1).state, `${shape}: one more unit than the recorded maximum must overflow`).toBeGreaterThan(STATE_CAP);
    sizes.push(["max", max]);
    sizes.forEach(([label, m], index) => {
      const ratio = m.state / m.markdown;
      rows.push(`| ${shape} | ${label} | ${m.markdown.toLocaleString("en-US")} | ${m.state.toLocaleString("en-US")} | ${ratio.toFixed(2)} |`);
      const expected = EXPECTED[shape]?.[index] ?? 0;
      if (Math.abs(ratio - expected) > expected * TOLERANCE) failures.push(`${shape} ${label}: ${ratio.toFixed(2)} vs recorded ${expected}`);
    });
  }
  process.stdout.write(`\n${rows.join("\n")}\n\n`);
  expect(failures).toEqual([]);
}, 3_600_000);
