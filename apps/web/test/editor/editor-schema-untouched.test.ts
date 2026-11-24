import { Editor, rootCtx, schemaCtx } from '@milkdown/core';
import { collab } from '@milkdown/plugin-collab';
import { grimoireEditorPlugins } from '@tektum/grimoire-editor-schema';
import { afterEach, describe, expect, it } from 'vitest';
import { mountReadOnly, type InspectableEditor } from '../../src/editor/core/mount';
import { uiPlugins } from '../../src/editor/core/plugins';

const mounted: InspectableEditor[] = [];
const editors: Editor[] = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((m) => m.destroy()));
  await Promise.all(editors.splice(0).map((e) => e.destroy(true)));
  document.body.replaceChildren();
});

const element = () => document.body.appendChild(document.createElement('div'));
const namesOf = (editor: Editor) => editor.action((ctx) => ({ nodes: Object.keys(ctx.get(schemaCtx).nodes).sort(), marks: Object.keys(ctx.get(schemaCtx).marks).sort() }));

/** What the shared plugins make, with nothing of the screen added: the reference. */
async function reference() {
  const editor = Editor.make()
    .config((ctx) => void ctx.set(rootCtx, element()))
    .use(grimoireEditorPlugins);
  await editor.create();
  editors.push(editor);
  return namesOf(editor);
}

describe('the screen adds nothing to the schema', () => {
  it('the editor the screen mounts has exactly the node and mark types of the shared plugins alone', async () => {
    const expected = await reference();
    expect(expected.nodes.length).toBeGreaterThan(10); // not an empty schema compared with an empty schema
    const shown = await mountReadOnly(element(), '# A heading\n\nText with **bold** and a [link](https://example.com).\n');
    mounted.push(shown);
    const names = shown.schemaNames();
    expect([...names.nodes].sort()).toEqual(expected.nodes);
    expect([...names.marks].sort()).toEqual(expected.marks);
  });

  it('adding the collaboration plugin and the allow-listed screen plugins does not add a node or a mark either', async () => {
    const expected = await reference();
    const live = Editor.make()
      .config((ctx) => void ctx.set(rootCtx, element()))
      .use(grimoireEditorPlugins)
      .use(uiPlugins)
      .use(collab);
    await live.create();
    editors.push(live);
    expect(namesOf(live)).toEqual(expected);
  });
});
