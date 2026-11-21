import { commandsCtx } from "@milkdown/core";
import { describe, expect, it } from "vitest";
import { setBlockLevelCommand } from "../src/index.js";
import { makeEditor } from "./helpers.js";

describe("browser commands and input rules", () => {
  it("typing ### and a space makes a level 3 block, never a heading node", async () => {
    const editor = await makeEditor({ markdown: "\n" });
    const view = editor.view();
    view.dispatch(view.state.tr.insertText("###"));
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) => handler(view, from, to, " ", () => view.state.tr));
    expect(handled).toBe(true);
    expect(editor.doc().firstChild?.type.name).toBe("paragraph");
    expect(editor.doc().firstChild?.attrs["level"]).toBe(3);
  });

  it("the command sets and clears a level and refuses an invalid one", async () => {
    const editor = await makeEditor({ markdown: "text\n" });
    const run = (level: number): boolean => editor.editor.action((ctx) => ctx.get(commandsCtx).call(setBlockLevelCommand.key, level));
    expect(run(4)).toBe(true);
    expect(editor.markdown()).toBe("#### text\n");
    expect(run(0)).toBe(true);
    expect(editor.markdown()).toBe("text\n");
    expect(run(7)).toBe(false);
  });
});
