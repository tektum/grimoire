import { describe, expect, it } from "vitest";
import { schemaCtx } from "@milkdown/core";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { FRAGMENT_NAME } from "../src/index.js";
import { makeEditor, yjsRoundTrip } from "./helpers.js";

// Both losses below were measured with the plain commonmark and gfm presets; the shared plugin array fixes them
// (docs/proof/m2-schema-fixes.md). A fixed case must survive a Yjs round trip; a known loss is pinned as a canary.
describe("losses through a Yjs round trip", () => {
  describe("image-link: fixed", () => {
    for (const source of [
      "[![alt](i.png)](http://l)\n",
      '[![alt](i.png "t")](http://l "lt")\n',
      "text [![a](b.png)](c) and [x](y)\n",
    ]) {
      it(`keeps ${JSON.stringify(source)}`, async () => {
        const { direct, viaYjs } = await yjsRoundTrip(source);
        expect(direct).toBe(source);
        expect(viaYjs).toBe(source);
      });
    }

    it("canary: a link around an image plus other content still loses the link on the image", async () => {
      const { direct, viaYjs } = await yjsRoundTrip("[![a](b.png) tail](c)\n");
      expect(direct).toBe("[![a](b.png) tail](c)\n");
      expect(viaYjs).not.toBe(direct);
    });
  });

  describe("table-alignment: fixed", () => {
    it("keeps an unaligned table unaligned", async () => {
      const source = "| a | b |\n| - | - |\n| 1 | 2 |\n";
      const { direct, viaYjs } = await yjsRoundTrip(source);
      expect(direct).toBe(source);
      expect(viaYjs).toBe(source);
      expect(viaYjs).not.toContain(":-");
    });

    it("keeps left, centre and right alignment", async () => {
      const source = "| a  | b  | c  |\n| :- | :-: | -: |\n| 1  | 2  | 3  |\n";
      const { direct, viaYjs } = await yjsRoundTrip(source);
      expect(viaYjs).toBe(direct);
      expect(viaYjs).toMatch(/:-+:/);
    });
  });

  describe("link with mixed marks: fixed", () => {
    it("writes one link around text with emphasis and strong, with and without Yjs", async () => {
      const source = "[*em* and **st**](u)\n";
      const { direct, viaYjs } = await yjsRoundTrip(source);
      expect(direct).toBe(source);
      expect(viaYjs).toBe(source);
    });
  });

  describe("empty heading: known loss in Markdown, not in Yjs", () => {
    it("the level survives the Yjs state while the Markdown drops the empty block", async () => {
      const editor = await makeEditor({ markdown: "## x\n" });
      const view = editor.view();
      view.dispatch(view.state.tr.delete(1, 2));
      expect(editor.markdown()).toBe("");
      const ydoc = new Y.Doc();
      prosemirrorToYXmlFragment(editor.doc(), ydoc.getXmlFragment(FRAGMENT_NAME));
      const schema = editor.editor.action((ctx) => ctx.get(schemaCtx));
      const back = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT_NAME), schema);
      expect(back.firstChild?.attrs["level"]).toBe(2);
      expect(back.firstChild?.childCount).toBe(0);
    });

    it("an empty plain paragraph is written as nothing too", async () => {
      const editor = await makeEditor({ markdown: "x\n" });
      const view = editor.view();
      view.dispatch(view.state.tr.delete(1, 2));
      expect(editor.markdown()).toBe("");
    });

    it("# alone and ## followed by nothing both write nothing", async () => {
      for (const source of ["#\n", "## \n"]) expect((await yjsRoundTrip(source)).viaYjs).toBe("");
    });
  });
});
