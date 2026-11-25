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

  it('does not take the focus from a field the person is typing in, when it is ready later: the title of a new page opens after a tree row was put in rename', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    document.body.innerHTML = '<div id="shell"><input id="late" /></div><input id="typing" />';
    const late = document.getElementById('late') as HTMLInputElement;
    const typing = document.getElementById('typing') as HTMLInputElement;
    document.getElementById('shell')!.setAttribute('inert', '');
    focusWhenReady(late); // not ready: the app is inert for a moment
    typing.focus(); // the person starts typing elsewhere meanwhile
    document.getElementById('shell')!.removeAttribute('inert');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.activeElement).toBe(typing);
  });

  it.each([
    ['an input', '<input id="other" />'],
    ['a text area', '<textarea id="other"></textarea>'],
    ['a select', '<select id="other"><option>a</option></select>'],
    ['an editable element', '<div id="other" contenteditable="true" tabindex="0"></div>'],
  ])('leaves the focus on %s that already has it when the field is ready', (_name, html) => {
    document.body.innerHTML = `<div id="shell"><input id="f" /></div>${html}`;
    const other = document.getElementById('other') as HTMLElement;
    other.focus();
    expect(document.activeElement).toBe(other);
    focusWhenReady(document.getElementById('f') as HTMLElement);
    expect(document.activeElement).toBe(other);
  });

  it.each([
    ['a button', '<button id="other">menu</button>'],
    ['a link', '<a id="other" href="#x">link</a>'],
  ])('still takes the focus from %s: the one a menu item or a button leaves it on', (_name, html) => {
    document.body.innerHTML = `<div id="shell"><input id="f" /></div>${html}`;
    (document.getElementById('other') as HTMLElement).focus();
    const input = document.getElementById('f') as HTMLInputElement;
    focusWhenReady(input);
    expect(document.activeElement).toBe(input);
  });

  it('takes the focus when it is the field that already has it, and when nothing has it', () => {
    const { input } = field();
    input.focus();
    focusWhenReady(input);
    expect(document.activeElement).toBe(input);
  });
});
