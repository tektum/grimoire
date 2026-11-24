import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Bubble, LINK_ERROR_ID, type BubbleProps } from '../../src/editor/menus/Bubble';
import '../support/dom';

const props = (over: Partial<BubbleProps> = {}): BubbleProps => ({
  active: { bold: false, italic: false, strike: false, code: false },
  link: null,
  mode: 'format',
  refusal: null,
  onToggle: () => undefined,
  onOpenLink: () => undefined,
  onApply: () => undefined,
  onCancel: () => undefined,
  ...over,
});

describe('the bubble', () => {
  it('is a toolbar of five buttons with names, each with its state, and a press does not take the focus from the text', async () => {
    const onToggle = vi.fn();
    const onOpenLink = vi.fn();
    render(<Bubble {...props({ active: { bold: true, italic: false, strike: false, code: false }, link: 'https://example.com', onToggle, onOpenLink })} />);
    expect(screen.getByRole('toolbar', { name: 'Text formatting' })).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Bold', 'Italic', 'Strikethrough', 'Code', 'Link']);
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Italic' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Link' }).getAttribute('aria-pressed')).toBe('true');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    screen.getByRole('button', { name: 'Italic' }).dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Strikethrough' }));
    expect(onToggle).toHaveBeenCalledWith('strike');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(onOpenLink).toHaveBeenCalled();
  });

  it('the link editor has a field with a label, takes the focus, shows the address of the link, and applies on Enter', async () => {
    const onApply = vi.fn();
    render(<Bubble {...props({ mode: 'link', link: 'https://example.com', onApply })} />);
    const field = screen.getByRole('textbox', { name: 'Link address' }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('https://example.com');
    await userEvent.clear(field);
    await userEvent.type(field, 'mailto:a@b.test{Enter}');
    expect(onApply).toHaveBeenCalledWith('mailto:a@b.test');
  });

  it('offers Remove link only for a link, and removing is applying nothing; Cancel and Escape cancel', async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(<Bubble {...props({ mode: 'link', link: null, onApply, onCancel })} />);
    expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await userEvent.type(screen.getByRole('textbox', { name: 'Link address' }), '{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    unmount();
    render(<Bubble {...props({ mode: 'link', link: 'https://example.com', onApply })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onApply).toHaveBeenCalledWith('');
  });

  it('shows a refusal as an alert, tied to the field, and the field is marked invalid', () => {
    render(<Bubble {...props({ mode: 'link', refusal: 'Only web, mail and relative links are allowed' })} />);
    expect(screen.getByRole('alert').textContent).toBe('Only web, mail and relative links are allowed');
    expect(screen.getByRole('alert').id).toBe(LINK_ERROR_ID);
    const field = screen.getByRole('textbox', { name: 'Link address' });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(LINK_ERROR_ID);
  });
});
