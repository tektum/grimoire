import { describe, expect, it } from 'vitest';
import { BLOCK_KINDS, matchingKinds } from '../../src/editor/menus/blocks';
import { plainEditor } from './support';

describe('the block kinds of the menu', () => {
  it('each has its own id, a label and a description, so each has an accessible name', () => {
    expect(new Set(BLOCK_KINDS.map((kind) => kind.id)).size).toBe(BLOCK_KINDS.length);
    for (const kind of BLOCK_KINDS) {
      expect(kind.label.trim(), kind.id).not.toBe('');
      expect(kind.description.trim(), kind.id).not.toBe('');
    }
    expect(BLOCK_KINDS.map((kind) => kind.id)).toEqual([
      'text',
      'heading-1',
      'heading-2',
      'heading-3',
      'heading-4',
      'heading-5',
      'heading-6',
      'bullet-list',
      'numbered-list',
      'task-list',
      'quote',
      'code',
      'divider',
      'table',
    ]);
  });

  it('nothing typed gives every kind; a word gives those that have it, the ones that start with it first; no match gives none', () => {
    expect(matchingKinds('')).toEqual(BLOCK_KINDS);
    expect(matchingKinds('  ')).toEqual(BLOCK_KINDS);
    expect(matchingKinds('head').map((kind) => kind.id)).toEqual(['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6']);
    expect(matchingKinds('LIST').map((kind) => kind.id)).toEqual(['bullet-list', 'numbered-list', 'task-list']);
    expect(matchingKinds('todo').map((kind) => kind.id)).toEqual(['task-list']);
    expect(matchingKinds('ode').map((kind) => kind.id)).toEqual(['code']); // inside a word: found, after the ones that start with it
    expect(matchingKinds('zzz')).toEqual([]);
  });

  it('each kind does its work on the block the cursor is in, and says so; the document is the Markdown that kind is', async () => {
    const expected: Record<string, RegExp> = {
      'heading-1': /^# Some words$/m,
      'heading-4': /^#### Some words$/m,
      'heading-6': /^###### Some words$/m,
      'bullet-list': /^[-*] Some words$/m,
      'numbered-list': /^1\. Some words$/m,
      'task-list': /^[-*] \[ \] Some words$/m,
      quote: /^> Some words$/m,
      code: /^```\s*\nSome words\n```$/m,
      divider: /^(---|\*\*\*|___)$/m,
      table: /^\|.*\|$/m,
    };
    for (const [id, pattern] of Object.entries(expected)) {
      const t = await plainEditor('Some words');
      try {
        t.cursorAtEnd();
        const kind = BLOCK_KINDS.find((candidate) => candidate.id === id)!;
        expect(
          t.editor.action((ctx) => kind.run(ctx)),
          id,
        ).toBe(true);
        expect(t.markdown(), id).toMatch(pattern);
      } finally {
        await t.destroy();
      }
    }
  });

  it('text turns a heading back into a paragraph, with its words', async () => {
    const t = await plainEditor('## Some words');
    try {
      t.cursorAtEnd();
      expect(t.editor.action((ctx) => BLOCK_KINDS[0]!.run(ctx))).toBe(true);
      expect(t.markdown().trim()).toBe('Some words');
    } finally {
      await t.destroy();
    }
  });
});
