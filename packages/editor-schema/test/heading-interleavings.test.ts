import { commandsCtx, editorViewCtx } from "@milkdown/core";
import type { MilkdownPlugin } from "@milkdown/ctx";
import { commonmark, turnIntoTextCommand, wrapInHeadingCommand } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { TextSelection } from "@milkdown/prose/state";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { setBlockLevelCommand } from "../src/index.js";
import { seeded } from "./generate.js";
import { linkDocs, makeEditor, type TestEditor } from "./helpers.js";

const RUNS = 200;
const BASE = "alpha beta gamma\n\n## delta\n";

interface Outcome {
  seed: number;
  level: number;
  tokens: string[];
  a: TestEditor;
  b: TestEditor;
}

/**
 * One interleaving: editor A changes the level of the first block (step 0 always sets 1 to 6, later steps 0 to 6)
 * while editor B types in it; after each step the two sides sometimes exchange updates and sometimes not (concurrent).
 */
async function interleave(seed: number, plugins: MilkdownPlugin[] | undefined, setLevel: (editor: TestEditor, level: number) => void): Promise<Outcome> {
  const next = seeded(seed * 104729);
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const sync = linkDocs(docA, docB);
  const a = await makeEditor({ ydoc: docA, markdown: BASE, ...(plugins ? { plugins } : {}) });
  sync.flush();
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), "remote");
  const b = await makeEditor({ ydoc: docB, ...(plugins ? { plugins } : {}) });
  const tokens: string[] = [];
  let level = 0;
  const steps = 2 + Math.floor(next() * 4);
  for (let step = 0; step < steps; step++) {
    if (step === 0 || next() < 0.4) {
      level = step === 0 ? 1 + Math.floor(next() * 6) : Math.floor(next() * 7);
      const view = a.view();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
      setLevel(a, level);
    } else {
      const view = b.editor.action((ctx) => ctx.get(editorViewCtx));
      // Only at the start or after a space, and the token ends with a space: never inside an earlier token.
      const text = view.state.doc.child(0).textContent;
      const spots = [1, ...[...text].flatMap((char, index) => (char === " " ? [index + 2] : []))];
      const token = `Q${seed}x${step}`;
      tokens.push(token);
      view.dispatch(view.state.tr.insertText(`${token} `, spots[Math.floor(next() * spots.length)] ?? 1));
    }
    if (next() < 0.5) sync.flush();
  }
  sync.flush();
  return { seed, level, tokens, a, b };
}

const occurrences = (text: string, token: string): number => text.split(token).length - 1;

async function finish(outcome: Outcome): Promise<void> {
  await outcome.a.editor.destroy();
  await outcome.b.editor.destroy();
}

describe("one editor changes a paragraph's heading level while the other types in it", () => {
  it(`${RUNS} seeded interleavings: both sides show the paragraph at the chosen level, with every typed token once, in that block`, async () => {
    for (let seed = 1; seed <= RUNS; seed++) {
      const outcome = await interleave(seed, undefined, (editor, level) => {
        editor.editor.action((ctx) => ctx.get(commandsCtx).call(setBlockLevelCommand.key, level));
      });
      for (const [side, editor] of [["A", outcome.a], ["B", outcome.b]] as const) {
        const doc = editor.doc();
        const where = `seed ${seed} editor ${side}`;
        const first = doc.child(0);
        expect(first.type.name, where).toBe("paragraph");
        expect(first.attrs["level"], where).toBe(outcome.level);
        let headings = 0;
        doc.descendants((node) => {
          if (node.type.name === "heading") headings += 1;
        });
        expect(headings, where).toBe(0);
        for (const token of outcome.tokens) {
          expect(occurrences(first.textContent, token), `${where} ${token} in block 0`).toBe(1);
          expect(occurrences(doc.textContent, token), `${where} ${token} in the document`).toBe(1);
        }
        expect(doc.child(1).attrs["level"], `${where} untouched heading`).toBe(2);
      }
      expect(outcome.b.markdown(), `seed ${seed}`).toBe(outcome.a.markdown());
      await finish(outcome);
    }
  }, 300_000);

  // The reason for the design: with the plain preset a heading is a node type of its own, changing the level replaces
  // the element in Yjs, and text typed into the old element at the same time is lost or the sides diverge.
  it(`control: against the plain preset (heading as its own node type) some of the ${RUNS} interleavings lose typed text or diverge`, async () => {
    const plain: MilkdownPlugin[] = [...commonmark, ...gfm].flat();
    let broken = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const outcome = await interleave(seed, plain, (editor, level) => {
        editor.editor.action((ctx) => {
          const commands = ctx.get(commandsCtx);
          if (level === 0) commands.call(turnIntoTextCommand.key);
          else commands.call(wrapInHeadingCommand.key, level);
        });
      });
      const a = outcome.a.markdown();
      const b = outcome.b.markdown();
      const lost = outcome.tokens.some((token) => occurrences(a, token) !== 1 || occurrences(b, token) !== 1);
      if (a !== b || lost) broken += 1;
      await finish(outcome);
    }
    expect(broken).toBeGreaterThan(0);
    process.stdout.write(`\ncontrol (plain preset): ${broken} of ${RUNS} interleavings lose typed text or diverge\n`);
  }, 300_000);
});
