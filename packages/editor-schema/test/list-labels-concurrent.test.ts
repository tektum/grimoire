import { editorViewCtx } from "@milkdown/core";
import type { Node } from "@milkdown/prose/model";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { normaliseForMarkdown } from "../src/index.js";
import { seeded } from "./generate.js";
import { linkDocs, makeEditor, type TestEditor } from "./helpers.js";

const plain = (node: Node): string => JSON.stringify(node.toJSON(), (key, value: unknown) => (key === "spread" ? undefined : value));

/** Labels of the ordered lists in the live document that are not `index + start`: wrong numbers on screen. */
function staleLabels(doc: Node): string[] {
  const stale: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "ordered_list") return;
    const order = typeof node.attrs["order"] === "number" ? (node.attrs["order"] as number) : 1;
    node.forEach((item, _offset, index) => {
      if (item.attrs["label"] !== `${index + order}.`) stale.push(`${String(item.attrs["label"])} at ${index + order}`);
    });
  });
  return stale;
}

interface Lists {
  pos: number;
  node: Node;
}
function listsOf(editor: TestEditor): Lists[] {
  const out: Lists[] = [];
  editor.doc().descendants((node, pos) => {
    if (node.type.name === "ordered_list" || node.type.name === "bullet_list") out.push({ pos, node });
  });
  return out;
}

/** Insert, delete or move one item of a random list, in one editor. */
function operate(editor: TestEditor, next: () => number, tag: string): void {
  const lists = listsOf(editor);
  const list = lists[Math.floor(next() * lists.length)];
  if (!list) return;
  const view = editor.editor.action((ctx) => ctx.get(editorViewCtx));
  const offsets: number[] = [];
  let offset = list.pos + 1;
  list.node.forEach((item) => {
    offsets.push(offset);
    offset += item.nodeSize;
  });
  const index = Math.floor(next() * list.node.childCount);
  const itemAt = (i: number): Node => list.node.child(i);
  const make = (source: Node): Node => source.type.create({ ...source.attrs }, view.state.schema.nodes["paragraph"]?.create({ level: 0 }, view.state.schema.text(tag)) ?? null);
  const roll = next();
  if (roll < 0.4) view.dispatch(view.state.tr.insert(offsets[index] ?? offset, make(itemAt(index))));
  else if (roll < 0.7 && list.node.childCount > 1) view.dispatch(view.state.tr.delete(offsets[index] ?? 0, (offsets[index] ?? 0) + itemAt(index).nodeSize));
  else if (list.node.childCount > 1) {
    // move: take item `index` out and put it at the other end
    const moved = itemAt(index);
    const tr = view.state.tr.delete(offsets[index] ?? 0, (offsets[index] ?? 0) + moved.nodeSize);
    view.dispatch(tr.insert(tr.mapping.map(index === 0 ? offset : (offsets[0] ?? list.pos + 1)), moved));
  } else view.dispatch(view.state.tr.insert(offset, make(itemAt(0))));
}

const SHAPES: [string, string][] = [
  ["five items", "1. a\n2. b\n3. c\n4. d\n5. e\n"],
  ["starting at 3", "3. a\n4. b\n5. c\n6. d\n"],
  ["nested", "1. a\n   1. a1\n   2. a2\n2. b\n   * b1\n   * b2\n3. c\n"],
  ["task list", "* [ ] a\n* [x] b\n* [ ] c\n* d\n"],
  ["ordered task mix", "1. a\n2. b\n   * [ ] t1\n   * [x] t2\n3. c\n"],
];

describe("ordered list labels with two editors on one document", () => {
  it("five items: A inserts at 2, B deletes item 4 and inserts at the end: both converge, and the document writes and reads back as its normal form", async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const sync = linkDocs(docA, docB);
    const a = await makeEditor({ ydoc: docA, markdown: "1. a\n2. b\n3. c\n4. d\n5. e\n" });
    sync.flush();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), "remote");
    const b = await makeEditor({ ydoc: docB });
    const view = (e: TestEditor) => e.editor.action((ctx) => ctx.get(editorViewCtx));
    const list = (e: TestEditor): Lists => listsOf(e)[0] as Lists;
    const offsetOf = (e: TestEditor, index: number): number => {
      let at = list(e).pos + 1;
      for (let i = 0; i < index; i++) at += list(e).node.child(i).nodeSize;
      return at;
    };
    const paragraph = (e: TestEditor, label: string): Node => list(e).node.child(0).type.create({ ...list(e).node.child(0).attrs }, view(e).state.schema.nodes["paragraph"]?.create({ level: 0 }, view(e).state.schema.text(label)) ?? null);
    view(a).dispatch(view(a).state.tr.insert(offsetOf(a, 1), paragraph(a, "A-new")));
    const four = list(b).node.child(3);
    view(b).dispatch(view(b).state.tr.delete(offsetOf(b, 3), offsetOf(b, 3) + four.nodeSize));
    view(b).dispatch(view(b).state.tr.insert(offsetOf(b, list(b).node.childCount), paragraph(b, "B-new")));
    sync.flush();
    expect(b.markdown()).toBe(a.markdown());
    expect(plain(a.doc())).toBe(plain(b.doc()));
    for (const editor of [a, b]) {
      const markdown = editor.markdown();
      expect(markdown).toContain("A-new");
      expect(markdown).toContain("B-new");
      expect(markdown).not.toContain("d\n");
      expect(plain(editor.parse(markdown))).toBe(plain(normaliseForMarkdown(editor.doc())));
    }
    // Whether the merged live document is numbered correctly on its own, on each side, is reported by the run below.
    process.stdout.write(`\nconcurrent five items: stale labels after sync A=${JSON.stringify(staleLabels(a.doc()))} B=${JSON.stringify(staleLabels(b.doc()))}\n`);
    // Known limit (docs/proof/m2-live-save.md, "Stale ordered-list numbers"): the live labels stay out of step until the page is written, and
    // the same on both sides. Pinned so that a fix is noticed: this fails when the labels are right, and when more than the five items are stale.
    for (const editor of [a, b]) {
      expect(staleLabels(editor.doc()).length).toBeGreaterThan(0);
      expect(staleLabels(editor.doc()).length).toBeLessThanOrEqual(5);
    }
    expect(staleLabels(a.doc()).length).toBe(staleLabels(b.doc()).length);
  });

  it("200 seeded interleavings of insert, delete and move on ordered, nested and task lists: converge, and write and read back as the normal form", async () => {
    let liveStale = 0;
    let example = "";
    for (let seed = 1; seed <= 200; seed++) {
      const next = seeded(seed * 15485863);
      const shape = SHAPES[seed % SHAPES.length] as [string, string];
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const sync = linkDocs(docA, docB);
      const a = await makeEditor({ ydoc: docA, markdown: shape[1] });
      sync.flush();
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), "remote");
      const b = await makeEditor({ ydoc: docB });
      const steps = 2 + Math.floor(next() * 5);
      for (let step = 0; step < steps; step++) {
        operate(next() < 0.5 ? a : b, next, `T${seed}s${step}`);
        if (next() < 0.4) sync.flush();
      }
      sync.flush();
      expect(b.markdown(), `seed ${seed} ${shape[0]}`).toBe(a.markdown());
      expect(plain(a.doc())).toBe(plain(b.doc()));
      for (const editor of [a, b]) {
        expect(plain(editor.parse(editor.markdown())), `seed ${seed} ${shape[0]} normal form`).toBe(plain(normaliseForMarkdown(editor.doc())));
        const stale = staleLabels(editor.doc());
        if (stale.length > 0) {
          liveStale++;
          if (!example) example = `seed ${seed} (${shape[0]}): ${JSON.stringify(stale)}\n${editor.markdown().split("\n").slice(0, 6).join(" | ")}`;
        }
      }
      await a.editor.destroy();
      await b.editor.destroy();
    }
    process.stdout.write(`\nlive documents (of 400) left with labels out of step after sync: ${liveStale}${example ? `; first: ${example}` : ""}\n`);
    // Known limit, pinned both ways. The count varies a little between runs (the order of concurrent inserts follows random client ids):
    // 42 to 44 of 400 measured. Zero means the limit is fixed; a quarter or more means the live labels got worse.
    expect(liveStale).toBeGreaterThan(0);
    expect(liveStale).toBeLessThan(100);
  }, 300_000);
});
