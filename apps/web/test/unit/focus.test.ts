import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusWhenReady } from '../../src/ui/focus';
import '../support/dom';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const field = () => {
  document.body.innerHTML = '<div id="shell"><input id="f" /></div>';
  return { shell: document.getElementById('shell')!, input: document.getElementById('f') as HTMLInputElement };
};

describe('the focus of a field that opens with a menu item', () => {
  it('is taken at once when nothing is inert', () => {
    const { input } = field();
    focusWhenReady(input);
    expect(document.activeElement).toBe(input);
  });

  it('is taken once the app stops being inert, not before and not lost', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const { shell, input } = field();
    shell.setAttribute('inert', '');
    focusWhenReady(input);
    expect(document.activeElement).not.toBe(input);
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).not.toBe(input);
    shell.removeAttribute('inert');
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(input);
  });

  it('stops when the field is gone, when it is cleaned up, and after a short while for an element that stays inert', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const { shell, input } = field();
    shell.setAttribute('inert', '');
    const cleanup = focusWhenReady(input) as (() => void) | undefined;
    cleanup?.();
    shell.removeAttribute('inert');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.activeElement).not.toBe(input); // cleaned up: no later focus
    const second = field();
    second.shell.setAttribute('inert', '');
    focusWhenReady(second.input);
    await vi.advanceTimersByTimeAsync(2000);
    second.shell.removeAttribute('inert');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.activeElement).not.toBe(second.input); // gave up
  });
});
