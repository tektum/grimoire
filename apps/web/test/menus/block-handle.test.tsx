import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BLOCK_KINDS } from '../../src/editor/menus/blocks';
import { BlockHandle, HANDLE_MENU_ID } from '../../src/editor/menus/BlockHandle';
import '../support/dom';

describe('the block handle button and its menu', () => {
  it('is a button that announces the menu and its state; closed, there is no list', async () => {
    const onToggle = vi.fn();
    render(<BlockHandle open={false} kinds={BLOCK_KINDS} active={0} onToggle={onToggle} onPick={() => undefined} onHover={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Block menu' });
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalled();
  });

  it('points the button at the item Enter would choose while the menu is open, and at nothing when it is closed', () => {
    const { rerender } = render(<BlockHandle open kinds={BLOCK_KINDS} active={1} onToggle={() => undefined} onPick={() => undefined} onHover={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Block menu' }).getAttribute('aria-activedescendant')).toBe('block-handle-menu-option-heading-1');
    rerender(<BlockHandle open={false} kinds={BLOCK_KINDS} active={1} onToggle={() => undefined} onPick={() => undefined} onHover={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Block menu' }).hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('open, it shows the list of kinds, points the button at it, and a press on a kind chooses it', () => {
    const onPick = vi.fn();
    render(<BlockHandle open kinds={BLOCK_KINDS} active={1} onToggle={() => undefined} onPick={onPick} onHover={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Block menu' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(HANDLE_MENU_ID);
    expect(screen.getByRole('listbox', { name: 'Turn this block into' }).id).toBe(HANDLE_MENU_ID);
    expect(screen.getAllByRole('option')).toHaveLength(BLOCK_KINDS.length);
    screen.getByRole('option', { name: /Quote/ }).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onPick).toHaveBeenCalledWith(BLOCK_KINDS.find((kind) => kind.id === 'quote'));
  });
});
