import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BLOCK_KINDS } from '../../src/editor/menus/blocks';
import { SLASH_MENU_ID, SlashMenu, slashOptionId } from '../../src/editor/menus/SlashMenu';
import '../support/dom';

describe('the slash menu list', () => {
  it('is a listbox with one option per kind, each named by its label and description, and the active one selected', () => {
    render(<SlashMenu kinds={BLOCK_KINDS} active={2} onPick={() => undefined} onHover={() => undefined} />);
    expect(screen.getByRole('listbox', { name: 'Turn this block into' }).id).toBe(SLASH_MENU_ID);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(BLOCK_KINDS.length);
    options.forEach((option, index) => {
      expect(option.getAttribute('aria-selected')).toBe(index === 2 ? 'true' : 'false');
      expect(option.id).toBe(slashOptionId(BLOCK_KINDS[index]!));
      expect(option.textContent?.trim()).not.toBe('');
    });
    expect(options[2]!.textContent).toContain('Heading 2');
  });

  it('a press on an option chooses it without taking the focus from the text; moving over one makes it the active one', async () => {
    const onPick = vi.fn();
    const onHover = vi.fn();
    render(<SlashMenu kinds={BLOCK_KINDS} active={0} onPick={onPick} onHover={onHover} />);
    const option = screen.getByRole('option', { name: /Quote/ });
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    option.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith(BLOCK_KINDS.find((kind) => kind.id === 'quote'));
    await userEvent.hover(option);
    expect(onHover).toHaveBeenCalledWith(BLOCK_KINDS.findIndex((kind) => kind.id === 'quote'));
  });

  it('with no kind it says so in a status, not an empty list', () => {
    render(<SlashMenu kinds={[]} active={0} onPick={() => undefined} onHover={() => undefined} />);
    expect(screen.getByRole('status').textContent).toBe('No block matches');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
