import { describe, expect, it } from "vitest";
import { yjsRoundTrip } from "./helpers.js";

// Markdown -> document -> Yjs -> document -> Markdown over a corpus of constructs: nothing is lost in Yjs.
const CORPUS: string[] = [
  "# H1\n",
  "## H2\n",
  "### H3\n",
  "#### H4\n",
  "##### H5\n",
  "###### H6\n",
  "plain *em* **strong** ~~gone~~ `code`\n",
  "[a link](http://x.y \"t\")\n",
  "![img](i.png \"t\")\n",
  "[![img](i.png)](http://l)\n",
  "[*em* and **st**](u)\n",
  "* a\n* b\n",
  "1. a\n2. b\n",
  "* a\n  * b\n    * c\n",
  "* [ ] todo\n* [x] done\n",
  "> quote\n\n> > nested\n",
  "```ts\nconst x = 1;\n```\n",
  "***\n",
  "| a | b |\n| - | - |\n| 1 | 2 |\n",
  "| a  | b  | c  |\n| :- | :-: | -: |\n| 1  | 2  | 3  |\n",
  "| *e* | `c` |\n| - | - |\n| [l](u) | ![i](u) |\n",
  "a\\\nb\n",
  "a<b>c\n",
  "\\*not em\\*\n",
  "* a\n\n  b\n\n* c\n",
  "* item\n\n  ```\n  code\n  ```\n",
  "* item\n  > quote\n",
  "1. a\n   1. b\n",
  "**bold *nested em* bold**\n",
  "text with trailing\\\nbreak and more\n",
  "## heading with `code` and [link](u)\n"
];

describe(`Yjs round trip over ${CORPUS.length} constructs`, () => {
  it.each(CORPUS.map((markdown, index) => [index, markdown] as const))("construct %i keeps its Markdown through Yjs", async (_index, markdown) => {
    const { direct, viaYjs } = await yjsRoundTrip(markdown);
    expect(viaYjs).toBe(direct);
    expect(direct.length).toBeGreaterThan(0);
  });

  it("has at least 28 constructs", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(28);
  });
});
