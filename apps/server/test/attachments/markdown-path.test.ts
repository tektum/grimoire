import { describe, expect, it } from 'vitest';
import { convertInProcess, seedInProcess } from '@tektum/grimoire-adapter-markdown-milkdown';
import { cleanFileName } from '@tektum/grimoire-core/attachments/file-name';
import { markdownPathFor } from '@tektum/grimoire-core/attachments/key';
import { isSafeUrl } from '@tektum/grimoire-editor-schema';

const ID = '01927f3e-5b7a-7c3d-8e1f-0a1b2c3d4e5f';
const names = ['a b#c%d(e)[f].png', `${'x'.repeat(251)}.png`, '.hidden.png', 'a:b.png', 'ä ö ü 日本語.png', 'sp ace  .png', "it's.png", 'a&b=c.png', '100%.png', 'tab\tname.png'];

describe('the Markdown path of an attachment, for the worst names', () => {
  for (const raw of names) {
    const name = cleanFileName(raw);
    const path = markdownPathFor(ID, name);

    it(`is a safe image address for ${JSON.stringify(raw.slice(0, 24))}`, () => {
      expect(isSafeUrl(path, 'image'), path).toBe(true);
    });

    it(`is kept by the editor and written back unchanged for ${JSON.stringify(raw.slice(0, 24))}`, async () => {
      const markdown = `![](${path})\n`;
      const seeded = await seedInProcess(markdown);
      if (!seeded.ok) throw new Error('seed');
      const back = await convertInProcess(seeded.state);
      if (!back.ok) throw new Error('convert');
      expect(back.markdown).toBe(markdown);
    });
  }
});
