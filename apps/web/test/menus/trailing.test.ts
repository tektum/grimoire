import { describe, expect, it } from 'vitest';
import { plainEditor } from './support';

describe('the empty paragraph after a last block that is not text', () => {
  it('is added once the document changes, where it can be edited, and it is not in the Markdown', async () => {
    const t = await plainEditor('Intro\n\n```\ncode\n```');
    try {
      const view = t.view();
      expect(view.state.doc.lastChild?.type.name).toBe('code_block');
      const before = t.markdown();
      view.dispatch(view.state.tr.insertText('!', 1));
      expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
      expect(view.state.doc.lastChild?.content.size).toBe(0);
      expect(t.markdown()).toBe(before.replace('Intro', '!Intro')); // the same Markdown, saved with or without the paragraph
      view.dispatch(view.state.tr.insertText('?', 1));
      expect(view.state.doc.childCount).toBe(3); // and not added again
    } finally {
      await t.destroy();
    }
  });

  it('is not added to a document that cannot be edited: a reader must not write into the shared document', async () => {
    const t = await plainEditor('Intro\n\n```\ncode\n```', { editable: false });
    try {
      const view = t.view();
      view.dispatch(view.state.tr.insertText('!', 1));
      expect(view.state.doc.lastChild?.type.name).toBe('code_block');
    } finally {
      await t.destroy();
    }
  });

  it('is not added after a paragraph', async () => {
    const t = await plainEditor('Only text');
    try {
      const view = t.view();
      view.dispatch(view.state.tr.insertText('!', 1));
      expect(view.state.doc.childCount).toBe(1);
    } finally {
      await t.destroy();
    }
  });
});
