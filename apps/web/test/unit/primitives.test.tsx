import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import SamplePage from '../../src/ui/SamplePage';
import { Button, CommandPalette, Confirm, Hint, Menu, Modal, notify, Toaster } from '../../src/ui/primitives';

beforeAll(() => {
  // happy-dom lacks these; Radix and cmdk call them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

describe('primitives', () => {
  it('Button is a button of type button, with a variant hook', () => {
    render(<Button variant="primary">Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.getAttribute('type')).toBe('button');
    expect(b.getAttribute('data-variant')).toBe('primary');
  });

  it('Modal has an accessible title and closes from its Close button', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <Modal title="Rename" open={open} onOpenChange={setOpen}>
          body
        </Modal>
      );
    }
    render(<Host />);
    expect(screen.getByRole('dialog', { name: 'Rename' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Confirm calls onConfirm from its action and not from Cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<Confirm title="Delete page" description="It moves to the trash." confirmLabel="Delete" open onOpenChange={onOpenChange} onConfirm={onConfirm} />);
    expect(screen.getByRole('alertdialog', { name: 'Delete page' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Confirm marks its verb destructive by default (never the accent), and takes the accent only where asked', async () => {
    const { unmount } = render(<Confirm title="Delete page" description="It moves to the trash." confirmLabel="Delete" open onOpenChange={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('data-variant')).toBe('destructive');
    unmount();
    render(<Confirm title="Reset the saved state" description="It is rebuilt." confirmLabel="Reset state" confirmVariant="primary" open onOpenChange={() => undefined} onConfirm={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Reset state' }).getAttribute('data-variant')).toBe('primary');
  });

  it('Menu opens from a named trigger and runs the chosen item', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Menu
        label="Page actions"
        items={[
          { label: 'Move', onSelect },
          { label: 'Delete', onSelect: () => {} },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Page actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('Hint shows its text on focus', async () => {
    const user = userEvent.setup();
    render(
      <Hint text="Bold">
        <Button>B</Button>
      </Hint>,
    );
    await user.tab();
    expect((await screen.findAllByText('Bold')).length).toBeGreaterThan(0);
  });

  it('CommandPalette filters by typing, runs the chosen item and closes', async () => {
    const user = userEvent.setup();
    const go = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        items={[
          { id: 'a', label: 'Go to Trash', onSelect: go },
          { id: 'b', label: 'Go to Search', onSelect: () => {} },
        ]}
      />,
    );
    await user.type(screen.getByPlaceholderText('Search, go to, or do'), 'trash');
    expect(screen.queryByText('Go to Search')).toBeNull();
    await user.click(screen.getByText('Go to Trash'));
    expect(go).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Toaster shows what notify is given', async () => {
    render(<Toaster />);
    notify('Try again');
    expect(await screen.findByText('Try again')).toBeTruthy();
  });
});

describe('SamplePage', () => {
  it('shows a heading, a list, a table, a code block, two named cursors and every collaborator colour with its name', () => {
    render(<SamplePage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Planning the autumn release');
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(8);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(document.querySelector('pre code')).toBeTruthy();
    expect(document.querySelectorAll('.cursor-label')).toHaveLength(2);
    expect(screen.getByRole('list', { name: 'Collaborator colours' }).children).toHaveLength(8);
  });
});
