import { Editor, parserCtx, remarkStringifyOptionsCtx, schemaCtx, serializerCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { describe, expect, it } from "vitest";
import { em, para, readsBackAs, text } from "./build.js";
import { installDom, makeEditor } from "./helpers.js";

// `docWithoutTrailingEmpties` is a copy of the preset's `doc` node with one change (it skips every trailing empty
// paragraph, the preset skips one). A Milkdown upgrade that changes the preset's node must fail here.
describe("the doc node copy against the preset's own", () => {
  it("has the same spec fields and content rule, parses and writes the same, and differs only in trailing empties", async () => {
    installDom();
    const preset = await Editor.make().use(commonmark).create();
    const ours = await makeEditor({ markdown: "x\n" });
    const presetDoc = preset.action((ctx) => ctx.get(schemaCtx)).nodes["doc"];
    const ourDoc = ours.editor.action((ctx) => ctx.get(schemaCtx)).nodes["doc"];
    expect(Object.keys(ourDoc?.spec ?? {}).sort()).toEqual(Object.keys(presetDoc?.spec ?? {}).sort());
    expect(ourDoc?.spec.content).toBe(presetDoc?.spec.content);

    const samples = ["a\n", "a\n\nb\n\n* c\n\n> d\n\n```\ne\n```\n\n***\n", "* a\n  * b\n\n1. c\n"];
    for (const markdown of samples) {
      const fromPreset = preset.action((ctx) => ctx.get(serializerCtx)(ctx.get(parserCtx)(markdown)));
      expect(ours.serialize(ours.parse(markdown))).toBe(fromPreset);
    }

    // The one intended difference: the preset leaves the first of two trailing empty paragraphs in the output.
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }, { type: "paragraph" }, { type: "paragraph" }] };
    const presetSchema = preset.action((ctx) => ctx.get(schemaCtx));
    const writtenByPreset = preset.action((ctx) => ctx.get(serializerCtx)(presetSchema.nodeFromJSON(doc)));
    const ourSchema = ours.editor.action((ctx) => ctx.get(schemaCtx));
    expect(writtenByPreset).toBe("a\n\n<br />\n");
    expect(ours.serialize(ourSchema.nodeFromJSON({ ...doc, content: doc.content.map((n) => ({ ...n, attrs: { level: 0 } })) }))).toBe("a\n");
  });
});

// `withoutAttentionHandlers` removes the preset's `emphasis` and `strong` write handlers by name; `escapingTextWriter`
// replaces `text`. A rename upstream would turn them into no-ops without a word, so both the names and the behaviour are pinned.
describe("the write handlers the shared array replaces", () => {
  it("the plain preset registers handlers under exactly the names we drop and replace", async () => {
    installDom();
    const preset = await Editor.make().use(commonmark).create();
    const handlers = preset.action((ctx) => ctx.get(remarkStringifyOptionsCtx).handlers ?? {});
    expect(Object.keys(handlers).sort()).toEqual(["emphasis", "strong", "text"]);
  });

  it("our array has none of the two attention handlers left, and has a text handler of its own", async () => {
    const ours = await makeEditor({ markdown: "x\n" });
    const handlers = ours.editor.action((ctx) => ctx.get(remarkStringifyOptionsCtx).handlers ?? {});
    expect(Object.keys(handlers).sort()).toEqual(["text"]);
  });

  it("behaviour: _em_ is written *em*, and an emphasis run ending in punctuation before a letter round-trips", async () => {
    const ours = await makeEditor({ markdown: "x\n" });
    expect(ours.serialize(ours.parse("_em_ and __strong__\n"))).toBe("*em* and **strong**\n");
    const r = await readsBackAs(para(0, text("a>", em), text("b")));
    expect(r).toMatchObject({ same: true, stable: true });
  });
});
