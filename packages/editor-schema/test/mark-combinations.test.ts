import { schemaCtx } from "@milkdown/core";
import type { Node } from "@milkdown/prose/model";
import { describe, expect, it } from "vitest";
import { normaliseForMarkdown } from "../src/index.js";
import { seeded, type Json } from "./generate.js";
import { makeEditor } from "./helpers.js";

const CASES = 4000;
const MARKS = ["emphasis", "strong", "strike_through", "inlineCode", "link"] as const;
// Edges: letters, digits, punctuation, spaces, and the characters Markdown reacts to.
const EDGES = ["a", "Z", "1", ".", "!", "(", ")", "-", "*", "_", "~", "`", "<", ">", "[", "]", "|", "\\", " ", "&", "\u00a0"];
const MIDDLES = ["x", "two words", "a_b", "2*3", ""];

function run(next: () => number): Json[] {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const runs = 2 + Math.floor(next() * 3);
  return Array.from({ length: runs }, (): Json => {
    const text = `${pick(EDGES)}${pick(MIDDLES)}${pick(EDGES)}`.replace(/^\s+$/, "x") || "x";
    const chosen = MARKS.filter(() => next() < 0.35);
    const marks = chosen.map((type) => (type === "link" ? { type, attrs: { href: "u", title: null } } : { type }));
    return { type: "text", text, ...(marks.length ? { marks } : {}) };
  });
}

/**
 * Characters with their marks. An ordinary space (U+0020) at the edge of a marked run carries none (which marks cover it there is invisible and
 * not compared); a space inside a run (both neighbours have exactly its marks) keeps them, and so does any other whitespace.
 */
function tokens(node: Node): string[] {
  const items: { token: string; marks?: string; space: boolean }[] = [];
  node.descendants((child) => {
    if (child.isText) {
      const marks = child.marks.map((m) => `${m.type.name}${JSON.stringify(m.attrs)}`).sort().join("+");
      for (const char of child.text ?? "") items.push({ token: char === " " ? " " : `${char}${marks}`, marks, space: char === " " });
    } else items.push({ token: `<${child.type.name}`, space: false });
  });
  return items.map((item, index) => {
    if (!item.space) return item.token;
    const before = items[index - 1];
    const after = items[index + 1];
    const interior = before?.marks === item.marks && after?.marks === item.marks;
    return interior ? ` ${item.marks}` : " ";
  });
}

/** The one remaining pattern: a space at the boundary of two runs whose mark sets overlap but neither contains the other. */
function crossingAt(run: Json | undefined, next: Json | undefined): boolean {
  const names = (r: Json | undefined): string[] => (r?.marks ?? []).map((m) => m.type);
  if (!run || !next || (run.text ?? "").slice(-1) !== " " && (next.text ?? "").charAt(0) !== " ") return false;
  const a = names(run);
  const b = names(next);
  return a.some((m) => b.includes(m)) && a.some((m) => !b.includes(m)) && b.some((m) => !a.includes(m));
}
function crossingMarksAtASpace(content: Json[]): boolean {
  return content.some((run, index) => crossingAt(run, content[index + 1]));
}

/** The runs that hold a character where two token lists differ (every text character is one token), if the lists differ inside the paragraph. */
function runsOfDifferences(content: Json[], a: string[], b: string[]): number[] | undefined {
  if (a.length !== b.length) return undefined;
  const runs = new Set<number>();
  for (let at = 0; at < a.length; at++) {
    if (a[at] === b[at]) continue;
    if (at === 0) return undefined; // the paragraph token itself differs: a structural change, never the pattern
    let start = 1; // the first token is the paragraph itself
    let found: number | undefined;
    for (const [index, run] of content.entries()) {
      const end = start + (run.text ?? "").length;
      if (at < end) { found = index; break; }
      start = end;
    }
    if (found === undefined) return undefined; // a difference outside the runs of the first paragraph
    runs.add(found);
  }
  return [...runs];
}

/**
 * Is the difference at this run explained by the listed pattern: a crossing pair at a space that includes the run?
 * Known limit: inside such a run any difference is accepted; telling the documented effect from another loss in the same run would need a per-character
 * model of the documented loss (a redesign of this test). Everything else is exact: other runs, the trailing paragraph and the characters themselves.
 */
function explainedByPattern(content: Json[], runs: number[] | undefined): boolean {
  if (runs === undefined) return false;
  return runs.every((run) => explainedRun(content, run)); // EVERY differing run must be part of the pattern, not only the first
}
function explainedRun(content: Json[], run: number): boolean { // the difference is not in the runs of the first paragraph (the fixed paragraph after it, or a difference in length): never the pattern
  return crossingAt(content[run - 1], content[run]) || crossingAt(content[run], content[run + 1]);
}

describe("which runs a difference belongs to", () => {
  const runs: Json[] = [{ type: "text", text: "ab", marks: [{ type: "strong" }] }, { type: "text", text: " c" }];
  it("a difference in a character belongs to its run; two differences give two runs", () => {
    expect(runsOfDifferences(runs, ["<p", "a", "b", " ", "c"], ["<p", "a", "x", " ", "y"])).toEqual([0, 1]);
    expect(runsOfDifferences(runs, ["<p", "a", "b", " ", "c"], ["<p", "a", "x", " ", "c"])).toEqual([0]);
  });
  it("a change of the paragraph token, or of the length, is never attributed to a run", () => {
    expect(runsOfDifferences(runs, ["<p", "a", "b", " ", "c"], ["<h", "a", "b", " ", "c"])).toBeUndefined();
    expect(runsOfDifferences(runs, ["<p", "a", "b", " ", "c"], ["<p", "a", "b", " "])).toBeUndefined();
  });
});

describe("every adjacency of emphasis, strong, strike-through, inline code and link", () => {
  it(`${CASES} seeded paragraphs of 2 to 4 runs with punctuation, digits and spaces at the edges: zero differences but the one listed pattern`, async () => {
    const editor = await makeEditor({ markdown: "x\n" });
    const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
    const failures: string[] = [];
    let known = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const content = run(seeded(seed * 7919));
      const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", attrs: { level: 0 }, content }, { type: "paragraph", attrs: { level: 0 }, content: [{ type: "text", text: "end" }] }] });
      const markdown = editor.serialize(doc);
      const read = editor.parse(markdown);
      const normal = normaliseForMarkdown(doc);
      const before = tokens(normal);
      const after = tokens(read);
      // The runs are those of the normal form (what the tokens are made of), so character positions and runs agree even where the normaliser changes the text.
      const normalRuns = ((normal.child(0).toJSON() as Json).content ?? []) as Json[];
      // The normal form still says what was typed: the same characters in the same order (spaces apart, which it may move).
      const letters = (value: Node): string => value.child(0).textContent.replace(/ /g, "");
      expect(letters(normal), `seed ${seed}`).toBe(letters(doc));
      const same = JSON.stringify(before) === JSON.stringify(after);
      // A difference in the document is explained only if it is at a run that is part of the listed pattern (a drift of the Markdown text alone has no place to look at).
      const explained = same ? crossingMarksAtASpace(content) : explainedByPattern(normalRuns, runsOfDifferences(normalRuns, before, after));
      if ((!same || editor.serialize(read) !== markdown) && explained) known++;
      else if (!same || editor.serialize(read) !== markdown) failures.push(`${seed}: ${JSON.stringify(markdown)} ${JSON.stringify(content.map((c) => [c.text, (c.marks ?? []).map((m) => m.type)]))}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(failures.length).toBe(0);
    expect(known).toBeLessThan(CASES * 0.01); // listed in the proof note as the one remaining pattern
  }, 300_000);
});
