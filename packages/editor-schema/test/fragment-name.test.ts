import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_NAME } from "../src/index.js";
import { makeEditor } from "./helpers.js";

describe("fragment name", () => {
  it("is prosemirror", () => {
    expect(FRAGMENT_NAME).toBe("prosemirror");
  });

  it("is the fragment the collab plugin writes, and the only shared type", async () => {
    const ydoc = new Y.Doc();
    await makeEditor({ ydoc, markdown: "# Hi\n" });
    expect([...ydoc.share.keys()]).toEqual([FRAGMENT_NAME]);
    expect(ydoc.getXmlFragment(FRAGMENT_NAME).length).toBeGreaterThan(0);
  });
});
