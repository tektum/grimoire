import { describe, expect, it, vi } from 'vitest';
import { rawHtmlView } from '../../src/safety/raw-html';

const HOSTILE = ['<img src=x onerror="window.__pwned=1">', '<script>window.__pwned=1</script>', '<a href="javascript:alert(1)">x</a>', '<iframe src="https://evil.example"></iframe>', '&lt;b&gt;'];

const fakeView = (editable: boolean) => {
  const replaceWith = vi.fn((from: number, to: number, content: unknown) => ({ replaced: [from, to, content] }));
  const dispatch = vi.fn();
  const text = vi.fn((value: string) => ({ text: value }));
  const focus = vi.fn();
  const view = { editable, dispatch, focus, state: { tr: { replaceWith }, schema: { text } } };
  return { view, replaceWith, dispatch, text, focus };
};
const MARKS = [{ type: { name: 'emphasis' } }];
const nodeOf = (value: string, nodeSize = value.length || 1) => ({ attrs: { value }, nodeSize, marks: MARKS });

describe('the raw HTML block', () => {
  it.each(HOSTILE)('shows %j as text and creates no element from it', (value) => {
    const { view } = fakeView(true);
    const { dom } = rawHtmlView(nodeOf(value) as never, view as never, () => 1);
    const root = dom as HTMLElement;
    expect(root.querySelector('code')?.textContent).toBe(value);
    expect([...root.querySelectorAll('*')].map((e) => e.tagName.toLowerCase())).toEqual(['code', 'button']);
    expect(root.contentEditable).toBe('false');
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('has a button named "Edit source" that turns the block into plain text of the page', () => {
    const { view, replaceWith, dispatch, text, focus } = fakeView(true);
    const { dom } = rawHtmlView(nodeOf('<b>x</b>', 8) as never, view as never, () => 5);
    const button = (dom as HTMLElement).querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('Edit source');
    button.click();
    expect(text).toHaveBeenCalledWith('<b>x</b>', MARKS); // the formatting and links around the block stay
    expect(replaceWith).toHaveBeenCalledWith(5, 13, { text: '<b>x</b>' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalled();
  });

  it('does nothing in a view that cannot be edited, or when the node has no position any more', () => {
    const readOnly = fakeView(false);
    ((rawHtmlView(nodeOf('<b>x</b>') as never, readOnly.view as never, () => 1).dom as HTMLElement).querySelector('button') as HTMLButtonElement).click();
    expect(readOnly.dispatch).not.toHaveBeenCalled();
    const gone = fakeView(true);
    ((rawHtmlView(nodeOf('<b>x</b>') as never, gone.view as never, () => undefined).dom as HTMLElement).querySelector('button') as HTMLButtonElement).click();
    expect(gone.dispatch).not.toHaveBeenCalled();
  });

  it('keeps ProseMirror out of the block: its events and its own changes are not handled', () => {
    const { view } = fakeView(true);
    const nodeView = rawHtmlView(nodeOf('<b>x</b>') as never, view as never, () => 1);
    expect(nodeView.stopEvent?.(new Event('click'))).toBe(true);
    expect(nodeView.ignoreMutation?.({} as never)).toBe(true);
  });
});
