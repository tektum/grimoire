import { describe, expect, it } from 'vitest';
import { parentPathOf, splitName, titleOf } from '../../../src/import/notion/names.js';

// M7-T06 (contracts section 4, Notion rules): constructed from the documented format, not observed. The id suffix regular expression is `^(.*?)[ -]?([a-f0-9]{32})(\.\w+)?$`.
const ID = '88ac0cea4cb245efb44d63ace0a37d1e';
const ID2 = '0123456789abcdef0123456789abcdef';

describe('splitName', () => {
  it('takes the id after a space, after a dash, and none; the extension apart', () => {
    expect(splitName(`Marketing campaign ${ID}.md`)).toEqual({ base: 'Marketing campaign', id: ID, ext: '.md' });
    expect(splitName(`Marketing-${ID}.md`)).toEqual({ base: 'Marketing', id: ID, ext: '.md' });
    expect(splitName(`Folder${ID}`)).toEqual({ base: 'Folder', id: ID, ext: '' });
    expect(splitName(`Tasks ${ID}_all.csv`)).toEqual({ base: `Tasks ${ID}_all`, id: undefined, ext: '.csv' }); // the `_all` form is not an id suffix: the database rule names it
    expect(splitName('Plain name.md')).toEqual({ base: 'Plain name', id: undefined, ext: '.md' });
    expect(splitName('picture.png')).toEqual({ base: 'picture', id: undefined, ext: '.png' });
  });

  it('with two ids, strips the last and keeps the first in the title', () => {
    expect(splitName(`Copy ${ID2} ${ID}.md`)).toEqual({ base: `Copy ${ID2}`, id: ID, ext: '.md' });
  });

  it('does not take 31 or 33 hex characters, or capitals, for an id', () => {
    expect(splitName(`Short ${ID.slice(1)}.md`).id).toBeUndefined();
    expect(splitName(`Long a${ID}.md`).id).toBe(ID); // 33 characters: the regex takes the last 32 and the 'a' stays in the name
    expect(splitName(`Caps ${ID.toUpperCase()}.md`).id).toBeUndefined();
  });
});

describe('titleOf', () => {
  it('is the file name without the id, and two pages with one title and different ids are two titles for two pages', () => {
    expect(titleOf(`Marketing campaign ${ID}.md`, '# Something else\n')).toBe('Marketing campaign');
    expect(titleOf(`Same title ${ID}.md`, '')).toBe(titleOf(`Same title ${ID2}.md`, ''));
  });

  it('is the first heading when the name has none (R10.5), else the base name', () => {
    expect(titleOf(`${ID}.md`, '\n\n## Heading two\n\nbody\n# H1\n')).toBe('Heading two');
    expect(titleOf(`${ID}.md`, 'no heading here')).toBe(ID);
    expect(titleOf('dir/Notes.md', '')).toBe('Notes');
  });

  it('reads a crafted heading in linear time (no backtracking on a long run of spaces and hashes)', () => {
    const t = Date.now();
    expect(titleOf(`${ID}.md`, `# ${'a #'.repeat(40_000)} x\n`).length).toBeGreaterThan(1000);
    expect(titleOf(`${ID}.md`, `#${' '.repeat(100_000)}\n`)).toBe(ID);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('takes a heading without its closing hashes', () => {
    expect(titleOf(`${ID}.md`, '## Plan ##\n')).toBe('Plan');
    expect(titleOf(`${ID}.md`, '# C# notes\n')).toBe('C# notes');
  });

  it('uses the last path segment and ignores the folders', () => {
    expect(titleOf(`Home ${ID2}/Child ${ID}.md`, '')).toBe('Child');
  });
});

describe('parentPathOf', () => {
  it('is the page file of the folder a page sits in (X <id>.md for X <id>/), and null at the top', () => {
    expect(parentPathOf(`Home ${ID2}/Child ${ID}.md`)).toBe(`Home ${ID2}.md`);
    expect(parentPathOf(`Home ${ID2}/Child ${ID}/Grand ${ID}.md`)).toBe(`Home ${ID2}/Child ${ID}.md`);
    expect(parentPathOf(`Home ${ID2}.md`)).toBeNull();
  });

  it('a folder with no id has no page file of its own: the parent is the folder itself', () => {
    expect(parentPathOf('Plain/Inside.md')).toBe('Plain/');
  });
});
