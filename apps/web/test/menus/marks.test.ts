import { TextSelection } from '@milkdown/prose/state';
import { describe, expect, it } from 'vitest';
import { LINK_REFUSAL, activeInline, bubbleSelection, linkAt, setLink, toggleInline } from '../../src/editor/menus/marks';
import { plainEditor } from './support';

type Editor = Awaited<ReturnType<typeof plainEditor>>;
const select = (t: Editor, from: number, to: number): void => {
  const view = t.view();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
};

describe('the bubble helpers', () => {
  it('say which marks the whole selection has, and the link it is in', async () => {
    const t = await plainEditor('plain **bold** and [a link](https://example.com/x) end');
    try {
      const view = t.view();
      const text = view.state.doc.textContent; // "plain bold and a link end"
      const at = (word: string): number => text.indexOf(word) + 1;
      select(t, at('bold'), at('bold') + 4);
      expect(activeInline(view.state)).toEqual({ bold: true, italic: false, strike: false, code: false });
      select(t, at('plain'), at('bold') + 4); // plain text and bold text: not all of it is bold
      expect(activeInline(view.state).bold).toBe(false);
      select(t, at('a link'), at('a link') + 6);
      expect(linkAt(view.state)).toBe('https://example.com/x');
      select(t, at('plain'), at('plain') + 5);
      expect(linkAt(view.state)).toBeNull();
      select(t, 1, 1);
      expect(activeInline(view.state).bold).toBe(false); // no range, no marks
    } finally {
      await t.destroy();
    }
  });

  it("toggle each inline mark on and off through the editor's commands", async () => {
    for (const [kind, written] of [
      ['bold', '**x**'],
      ['italic', '*x*'],
      ['strike', '~~x~~'],
      ['code', '`x`'],
    ] as const) {
      const t = await plainEditor('x');
      try {
        select(t, 1, 2);
        expect(toggleInline(await ctxOf(t), kind), kind).toBe(true);
        expect(t.markdown().trim(), kind).toBe(written);
        expect(activeInline(t.view().state)[kind], kind).toBe(true);
        toggleInline(await ctxOf(t), kind);
        expect(t.markdown().trim(), kind).toBe('x');
      } finally {
        await t.destroy();
      }
    }
  });

  it('put a link on the selection when the address is allowed, and refuse the others without touching the document', async () => {
    const t = await plainEditor('some words here');
    try {
      const view = t.view();
      select(t, 1, 5);
      for (const refused of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'vbscript:x']) {
        expect(setLink(view, refused), refused).toBe('refused');
      }
      expect(t.markdown().trim()).toBe('some words here');
      for (const allowed of ['https://example.com', 'mailto:a@b.test', '/p/x']) {
        select(t, 1, 5);
        expect(setLink(view, allowed), allowed).toBe('linked');
        expect(linkAt(view.state), allowed).toBe(allowed);
      }
      select(t, 1, 5);
      expect(setLink(view, '   '), 'an empty address takes the link off').toBe('unlinked');
      expect(linkAt(view.state)).toBeNull();
      select(t, 3, 3);
      expect(setLink(view, 'https://example.com'), 'no range, no link').toBe('refused');
      expect(LINK_REFUSAL).toBe('Only web, mail and relative links are allowed');
    } finally {
      await t.destroy();
    }
  });

  it('are for a range of text in an editor that can be edited, outside code', async () => {
    const t = await plainEditor('some words\n\n```\ncode here\n```');
    try {
      const view = t.view();
      select(t, 1, 5);
      expect(bubbleSelection(view)).toBe(true);
      select(t, 3, 3);
      expect(bubbleSelection(view)).toBe(false);
      let code = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'code_block') code = pos + 1;
      });
      select(t, code, code + 4);
      expect(bubbleSelection(view)).toBe(false);
      select(t, 1, 5);
      view.setProps({ editable: () => false });
      expect(bubbleSelection(view)).toBe(false);
    } finally {
      await t.destroy();
    }
  });
});

async function ctxOf(t: Editor) {
  return t.editor.action((ctx) => ctx);
}
