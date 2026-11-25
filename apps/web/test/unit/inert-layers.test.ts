import { afterEach, describe, expect, it } from 'vitest';
import { followDialogLayers } from '../../src/ui/inert-layers';
import '../support/dom';

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()!();
  document.body.innerHTML = '';
});
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
const follow = () => {
  stops.push(followDialogLayers());
};

describe('what the dialog library hides is made inert too', () => {
  it('makes an element inert while the library marks it, and gives it back when the mark goes', async () => {
    document.body.innerHTML = '<div id="app"><button>x</button></div>';
    follow();
    const app = document.getElementById('app')!;
    app.setAttribute('aria-hidden', 'true');
    app.setAttribute('data-aria-hidden', 'true');
    await settle();
    expect(app.hasAttribute('inert')).toBe(true);
    app.removeAttribute('aria-hidden');
    app.removeAttribute('data-aria-hidden');
    await settle();
    expect(app.hasAttribute('inert')).toBe(false);
    expect(app.hasAttribute('data-made-inert')).toBe(false);
  });

  it('takes what is already marked when it starts, and what is added already marked', async () => {
    document.body.innerHTML = '<div id="early" data-aria-hidden="true"></div>';
    follow();
    expect(document.getElementById('early')!.hasAttribute('inert')).toBe(true);
    const late = document.createElement('div');
    late.setAttribute('data-aria-hidden', 'true');
    document.body.append(late);
    await settle();
    expect(late.hasAttribute('inert')).toBe(true);
  });

  it('leaves an element that was inert before the library marked it inert afterwards', async () => {
    document.body.innerHTML = '<div id="own" inert></div>';
    follow();
    const own = document.getElementById('own')!;
    own.setAttribute('data-aria-hidden', 'true');
    await settle();
    own.removeAttribute('data-aria-hidden');
    await settle();
    expect(own.hasAttribute('inert')).toBe(true);
  });

  it('does not touch an element the library does not mark, and lets go of everything when stopped', async () => {
    document.body.innerHTML = '<div id="a"></div><div id="b" data-aria-hidden="true"></div>';
    const stop = followDialogLayers();
    expect(document.getElementById('a')!.hasAttribute('inert')).toBe(false);
    expect(document.getElementById('b')!.hasAttribute('inert')).toBe(true);
    stop();
    expect(document.getElementById('b')!.hasAttribute('inert')).toBe(false);
  });
});
