import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LockNotice } from '../../src/editor/lock/LockNotice';
import { LIMIT_TEXT, SOFT_LOCK_HELP, lockMessage } from '../../src/editor/lock/texts';
import HelpScreen from '../../src/screens/help';
import '../support/dom';

describe('the help page', () => {
  it('has a title and says what the lock protects and the limits of editing together, in their exact words', () => {
    const { container } = render(<HelpScreen />);
    expect(screen.getByRole('heading', { name: 'Editing together' })).toBeTruthy();
    expect([...container.querySelectorAll('.lock-help p')].map((p) => p.textContent)).toEqual([SOFT_LOCK_HELP, LIMIT_TEXT]);
  });
});

describe('the lock message', () => {
  it('names the person as the sentence the lock gives', () => {
    expect(lockMessage('Bob')).toBe('Bob is editing this block');
  });

  it('is an alert with the message, a "Why?" that opens the help and a link to the help page, and Close', async () => {
    const onDismiss = vi.fn();
    render(<LockNotice message="Bob is editing this block" onDismiss={onDismiss} />);
    expect(screen.getByRole('alert').textContent).toContain('Bob is editing this block');
    const why = screen.getByRole('button', { name: 'Why?' });
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.lock-help')).toBeNull();
    await userEvent.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    expect([...document.querySelectorAll('.lock-help p')].map((p) => p.textContent)).toEqual([SOFT_LOCK_HELP, LIMIT_TEXT]);
    expect(screen.getByRole('link', { name: 'The same on the help page' }).getAttribute('href')).toBe('/help');
    await userEvent.click(why);
    expect(document.querySelector('.lock-help')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape, and other keys are left alone', async () => {
    const onDismiss = vi.fn();
    render(<LockNotice message="Bob is editing this block" onDismiss={onDismiss} />);
    screen.getByRole('button', { name: 'Why?' }).focus();
    await userEvent.keyboard('a');
    expect(onDismiss).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
