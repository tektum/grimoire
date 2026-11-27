import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { InBar, Movable, PageControlsProvider, PageControlsSlot } from '../../src/app/page-controls';
import '../support/dom';

afterEach(cleanup);

const holder = (part: string): HTMLElement => document.querySelector(`.shell-page-part[data-part="${part}"]`)!;

describe('the top bar places for a page`s controls', () => {
  it('puts a control in its place in the bar when there is one and it has room, and in the page when it has not', () => {
    render(
      <PageControlsProvider>
        <PageControlsSlot />
        <main data-testid="page">
          <InBar part="menu" show><button>Menu</button></InBar>
          <InBar part="presence" show={false}><button>Presence</button></InBar>
        </main>
      </PageControlsProvider>,
    );
    expect(holder('menu').contains(screen.getByRole('button', { name: 'Menu' }))).toBe(true);
    expect(screen.getByTestId('page').contains(screen.getByRole('button', { name: 'Presence' }))).toBe(true);
  });

  it('keeps the bar`s order whichever control arrives first', () => {
    render(
      <PageControlsProvider>
        <PageControlsSlot />
        <InBar part="menu"><button>Menu</button></InBar>
        <InBar part="history"><button>History</button></InBar>
        <InBar part="status"><p>Saved</p></InBar>
      </PageControlsProvider>,
    );
    const order = [...document.querySelectorAll('.shell-page-part')].map((part) => part.textContent);
    expect(order).toEqual(['Saved', '', 'History', 'Menu']);
  });

  it('keeps a bar-only control out of the page, and everything in the page where there is no bar', () => {
    render(
      <PageControlsProvider>
        <PageControlsSlot />
        <main data-testid="page">
          <InBar part="history" barOnly show={false}><button>History</button></InBar>
        </main>
      </PageControlsProvider>,
    );
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    cleanup();
    render(
      <main data-testid="page">
        <InBar part="menu"><button>Menu</button></InBar>
        <InBar part="history" barOnly><button>History</button></InBar>
      </main>,
    );
    expect(screen.getByTestId('page').contains(screen.getByRole('button', { name: 'Menu' }))).toBe(true);
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  });

  it('moves a movable piece between the bar and the page as the same node, so what it holds survives', () => {
    function Page() {
      const [inBar, setInBar] = useState(true);
      return (
        <>
          <button onClick={() => { setInBar((x) => !x); }}>toggle</button>
          <main data-testid="page">
            <Movable part="status" inBar={inBar}>
              <input aria-label="draft" defaultValue="" />
            </Movable>
          </main>
        </>
      );
    }
    render(
      <PageControlsProvider>
        <PageControlsSlot />
        <Page />
      </PageControlsProvider>,
    );
    const input = screen.getByLabelText('draft');
    expect(holder('status').contains(input)).toBe(true);
    act(() => { screen.getByRole('button', { name: 'toggle' }).click(); });
    expect(screen.getByLabelText('draft')).toBe(input);
    expect(screen.getByTestId('page').contains(input)).toBe(true);
    act(() => { screen.getByRole('button', { name: 'toggle' }).click(); });
    expect(screen.getByLabelText('draft')).toBe(input);
    expect(holder('status').contains(input)).toBe(true);
  });
});
