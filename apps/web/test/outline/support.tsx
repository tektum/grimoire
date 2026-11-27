import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { Outline } from '../../src/outline';

/** `matchMedia` answering `(min-width: 1280px)` as the test says; other queries are false. */
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
          <div className="ProseMirror" contentEditable suppressContentEditableWarning>
            {headings.map(([level, text], i) => {
              const Tag = (level === 0 ? 'p' : `h${String(level)}`) as 'h1';
              return <Tag key={i}>{text}</Tag>;
            })}
          </div>
        </div>
      </article>
      <div className="page-margin">
        <Outline />
      </div>
    </div>,
  );
  const editor = view.container.querySelector('.ProseMirror') as HTMLElement;
  /** Replaces the document's blocks. An entry is `[level, text]`; a level of 0 is a paragraph. */
  const set = (list: readonly (readonly [number, string])[]): void => {
    editor.replaceChildren(
      ...list.map(([level, text]) => {
        const element = document.createElement(level === 0 ? 'p' : `h${String(level)}`);
        element.textContent = text;
        return element;
      }),
    );
  };
  return { ...view, editor, set };
}
