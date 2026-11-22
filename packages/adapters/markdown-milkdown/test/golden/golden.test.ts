import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertInProcess } from '../../src/index.js';
import { GOLDEN_DIR, loadCorpus } from '../../src/testing/corpus.js';
import { stateFromMarkdown } from '../../src/testing/states.js';

/**
 * Converted output of each stability case against a committed Markdown file. A change of Milkdown, y-prosemirror or the
 * schema that alters output fails here. After a reviewed upgrade, regenerate with `UPDATE_GOLDEN=1 bun run --filter <package> test`.
 */
const update = process.env['UPDATE_GOLDEN'] === '1';

describe('golden files', () => {
  it.each(loadCorpus())('$name converts to the committed Markdown', async ({ name, markdown }) => {
    const converted = await convertInProcess(await stateFromMarkdown(markdown));
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const file = `${GOLDEN_DIR}${name}.md`;
    if (update) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, converted.markdown);
    }
    expect(existsSync(file), `missing golden file ${name}.md (UPDATE_GOLDEN=1 writes it)`).toBe(true);
    expect(converted.markdown).toBe(readFileSync(file, 'utf8'));
  });
});
