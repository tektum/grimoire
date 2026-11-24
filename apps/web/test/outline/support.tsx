import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import { Outline } from '../../src/outline';

/** `matchMedia` answering `(min-width: 1200px)` as the test says; other queries are false. */
export function width(pixels: number): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    return { matches: min !== null && pixels >= Number(min[1]), media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
  });
}

/** The page's layout as the page screen builds it: the editor's element, and the margin the outline sits in. */
export function renderPage(headings: readonly (readonly [number, string])[] = []) {
  const view = render(
    <div className="page-layout">
      <article>
        <div className="page-editor" data-testid="editor-root">
          <div className="ProseMirror" contentEditable suppressContentEditableWarning />
        </div>
      </article>
      <div className="page-margin">
        <Outline />
      </div>
    </div>,
  );
  const editor = view.container.querySelector('.ProseMirror') as HTMLElement;
  const set = (list: readonly (readonly [number, string])[]): void => {
    editor.replaceChildren(
      ...list.map(([level, text]) => {
        const element = document.createElement(level === 0 ? 'p' : `h${String(level)}`);
        element.textContent = text;
        return element;
      }),
    );
  };
  set(headings);
  return { ...view, editor, set };
}

/** Lets the 200 ms debounce run. */
export const settle = async (ms = 250): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
