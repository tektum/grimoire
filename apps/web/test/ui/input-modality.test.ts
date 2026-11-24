import { afterEach, describe, expect, it } from 'vitest';
import { trackInputModality } from '../../src/ui/input-modality';

const root = (): string | undefined => document.documentElement.dataset['input'];
let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe('how the person last reached for the page', () => {
  it('says nothing until there is an input, `keyboard` after a Tab, `pointer` after a press, and keeps the last one through other keys', () => {
    stop = trackInputModality();
    expect(root()).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(root(), 'a letter is not a way of moving the focus').toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(root()).toBe('keyboard');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(root(), 'typing after a Tab keeps the ring').toBe('keyboard');
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(root()).toBe('pointer');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(root()).toBe('keyboard');
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(root()).toBe('pointer');
  });

  it('sees an input whose target stops it from bubbling (it listens in the capture phase), and the stop function takes everything away', () => {
    stop = trackInputModality();
    const inner = document.body.appendChild(document.createElement('button'));
    inner.addEventListener('keydown', (event) => event.stopPropagation());
    inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(root()).toBe('keyboard');
    stop();
    expect(root()).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(root(), 'after the stop nothing listens').toBeUndefined();
    inner.remove();
  });
});
