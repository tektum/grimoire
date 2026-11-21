import { describe, expect, it } from "vitest";
import { makeEditor } from "./helpers.js";

async function roundTrip(markdown: string): Promise<{ first: string; second: string; hasHeadingNode: boolean }> {
  const first = await makeEditor({ markdown });
  const once = first.markdown();
  let hasHeadingNode = false;
  first.doc().descendants((node) => {
    if (node.type.name === "heading") hasHeadingNode = true;
  });
  const second = await makeEditor({ markdown: once });
  return { first: once, second: second.markdown(), hasHeadingNode };
}

describe("headings are paragraphs with a level", () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    it(`level ${level} writes ${"#".repeat(level)} and reads it back`, async () => {
      const { first, second, hasHeadingNode } = await roundTrip(`${"#".repeat(level)} Title ${level}\n`);
      expect(first).toBe(`${"#".repeat(level)} Title ${level}\n`);
      expect(second).toBe(first);
      expect(hasHeadingNode).toBe(false);
    });
  }

  it("level 0 is plain text", async () => {
    const { first, second } = await roundTrip("just text\n");
    expect(first).toBe("just text\n");
    expect(second).toBe(first);
  });

  it("keeps the level attribute on a paragraph node", async () => {
    const editor = await makeEditor({ markdown: "## Two\n\nplain\n" });
    const levels = editor.doc().children.map((child) => [child.type.name, child.attrs["level"]]);
    expect(levels).toEqual([["paragraph", 2], ["paragraph", 0]]);
  });

  it("a mixed document is stable on a second pass", async () => {
    const source = "# One\n\ntext\n\n### Three\n\n* item\n\n###### Six\n";
    const { first, second } = await roundTrip(source);
    expect(first).toBe(source);
    expect(second).toBe(first);
  });
});
