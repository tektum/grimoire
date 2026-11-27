import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InBar, PageControlsProvider, PageControlsSlot } from '../../src/app/page-controls';
import '../support/dom';

afterEach(cleanup);

const bar = (): HTMLElement => document.querySelector('.shell-page-controls')!;

describe('the top bar slot for a page`s controls', () => {
  it('puts a control in the bar when there is one and it has room, and in the page when it has not', () => {
    const view = render(
      <PageControlsProvider>
        <PageControlsSlot />
        <main data-testid="page">
          <InBar show><button>Menu</button></InBar>
          <InBar show={false}><button>Status</button></InBar>
        </main>
      </PageControlsProvider>,
    );
    expect(bar().contains(screen.getByRole('button', { name: 'Menu' }))).toBe(true);
    expect(screen.getByTestId('page').contains(screen.getByRole('button', { name: 'Status' }))).toBe(true);
    view.unmount();
  });

  it('keeps a bar-only control out of the page, and a fallback-only one out of the bar', () => {
    render(
      <PageControlsProvider>
        <PageControlsSlot />
        <main data-testid="page">
          <InBar barOnly show={false}><button>History</button></InBar>
          <InBar fallbackOnly show><button>Inline status</button></InBar>
          <InBar fallbackOnly show={false}><button>Phone status</button></InBar>
        </main>
      </PageControlsProvider>,
    );
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inline status' })).toBeNull();
    expect(screen.getByTestId('page').contains(screen.getByRole('button', { name: 'Phone status' }))).toBe(true);
  });

  it('without a bar everything stays where the page put it, except what only the bar shows', () => {
    render(
      <main data-testid="page">
        <InBar><button>Menu</button></InBar>
        <InBar barOnly><button>History</button></InBar>
      </main>,
    );
    expect(screen.getByTestId('page').contains(screen.getByRole('button', { name: 'Menu' }))).toBe(true);
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  });
});
