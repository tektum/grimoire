import { describe, expect, it } from 'vitest';
import { convertInProcess } from '../../src/index.js';
import { getHeadless } from '../../src/headless.js';
import { makeReferenceEditor } from '../../src/testing/reference-editor.js';
import { stateFromMarkdown } from '../../src/testing/states.js';

const SAMPLE = [
  '# Title',
  '',
  'Intro with **bold**, *em*, `code` and a [link](https://example.com "T").',
  '',
  '## Lists',
  '',
  '- one',
  '  - nested',
  '- [x] task',
  '',
  '1. first',
  '2. second',
  '',
  '| left | right |',
  '|:-----|------:|',
  '| a | b |',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '> quote',
  '',
  '![alt](https://example.com/i.png "Img")',
  '',
  '[![logo](logo.png)](https://example.com)',
  '',
].join('\n');

const shape = (schema: { nodes: Record<string, { spec: { attrs?: object | undefined } }>; marks: Record<string, { spec: { attrs?: object | undefined } }> }) => ({
  nodes: Object.entries(schema.nodes).map(([name, type]) => [name, Object.keys(type.spec.attrs ?? {}).sort()]),
  marks: Object.entries(schema.marks).map(([name, type]) => [name, Object.keys(type.spec.attrs ?? {}).sort()]),
});

describe('headless converter against the full editor under happy-dom', () => {
  it('writes the same Markdown as the editor for a sample with every common construct', async () => {
    const editor = await makeReferenceEditor({ markdown: SAMPLE });
    const converted = await convertInProcess(await stateFromMarkdown(SAMPLE));
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.markdown).toBe(editor.markdown());
    const headless = await getHeadless();
    expect(headless.serialize(headless.parse(SAMPLE))).toBe(editor.markdown());
    await editor.destroy();
  });

  it('has the same node and attribute names and the same mark names as the editor', async () => {
    const editor = await makeReferenceEditor({ markdown: 'x' });
    const headless = await getHeadless();
    expect(shape(headless.schema)).toEqual(shape(editor.schema()));
    expect(shape(headless.schema).nodes.length).toBeGreaterThan(10);
    await editor.destroy();
  });
});
