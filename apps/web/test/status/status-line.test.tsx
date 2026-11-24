import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, type ConnectionState } from '../../src/editor/core/connection';
import { TEXTS } from '../../src/editor/core/map-signal';
import { SAVED_HOLD_MS, StatusLine, statusText } from '../../src/status';
import '../support/dom';
import { flush, harness } from '../editor/support';

const BASE: Pick<ConnectionState, 'text' | 'offline' | 'unsynced' | 'changes' | 'readOnly' | 'stopped'> = { text: null, offline: false, unsynced: 0, changes: 0, readOnly: false, stopped: null };

describe('statusText: what the line says', () => {
  it.each([
    ['connecting', { ...BASE }, 'connecting', 'Connecting…'],
    ['synced with nothing waiting', { ...BASE }, 'synced', 'Saved'],
    ['synced with changes waiting for the server', { ...BASE, unsynced: 3 }, 'synced', 'Saving'],
    ['a reader, synced (nothing of hers to save)', { ...BASE, readOnly: true, text: TEXTS.readOnly }, 'synced', 'Live'],
    ['offline for more than ten seconds, with changes kept', { ...BASE, offline: true, unsynced: 2, text: TEXTS.offline }, 'offline', TEXTS.offline],
    ['a refusal text wins over Saved', { ...BASE, text: TEXTS.busy }, 'connecting', TEXTS.busy],
    ['a refusal text wins over Saving', { ...BASE, text: TEXTS.pageFull, unsynced: 1 }, 'synced', TEXTS.pageFull],
    ['stopped with its text', { ...BASE, stopped: 'forbidden' as const, text: TEXTS.noAccess }, 'stopped', TEXTS.noAccess],
    ['disconnected (a hidden tab)', { ...BASE }, 'disconnected', null],
  ] as const)('%s', (_name, state, collab, expected) => {
    expect(statusText(state, collab)).toBe(expected);
  });
});

describe('the status line', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  const show = (state: Partial<ConnectionState>, collab: Parameters<typeof statusText>[1] = 'synced') => <StatusLine state={{ ...BASE, ...state } as ConnectionState} collab={collab} />;

  it('is the one polite live region: role status, aria-live polite, atomic', () => {
    render(show({}));
    const line = screen.getByRole('status');
    expect(line.getAttribute('aria-live')).toBe('polite');
    expect(line.getAttribute('aria-atomic')).toBe('true');
    expect(document.querySelectorAll('[role="status"], [aria-live]')).toHaveLength(1);
  });

  it('says Saving at once when a change is waiting, and Saved only after nothing has waited for a moment', () => {
    const view = render(show({ unsynced: 0 }));
    expect(screen.getByRole('status').textContent).toBe('Saved');
    view.rerender(show({ unsynced: 1, changes: 1 }));
    expect(screen.getByRole('status').textContent).toBe('Saving');
    view.rerender(show({ unsynced: 0, changes: 1 }));
    expect(screen.getByRole('status').textContent).toBe('Saving'); // the server answered, but typing may go on
    act(() => { vi.advanceTimersByTime(SAVED_HOLD_MS - 1); });
    expect(screen.getByRole('status').textContent).toBe('Saving');
    act(() => { vi.advanceTimersByTime(2); });
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it('shows Saving for the moment even when the server acknowledged the change before the screen drew it (a fast server)', () => {
    const view = render(show({ unsynced: 0, changes: 0 }));
    view.rerender(show({ unsynced: 0, changes: 1 })); // a change came and was acknowledged between two draws
    expect(screen.getByRole('status').textContent).toBe('Saving');
    act(() => { vi.advanceTimersByTime(SAVED_HOLD_MS + 10); });
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it('keeps the same element for the line through Saving and Saved: only its text changes', () => {
    const view = render(show({ unsynced: 0 }));
    const line = screen.getByRole('status');
    view.rerender(show({ unsynced: 1, changes: 1 }));
    view.rerender(show({ unsynced: 0, changes: 1 }));
    act(() => { vi.advanceTimersByTime(SAVED_HOLD_MS + 10); });
    expect(screen.getByRole('status')).toBe(line);
    expect(line.isConnected).toBe(true);
  });

  it('does not say Saved between keystrokes: a new change within the moment keeps Saving', () => {
    const view = render(show({ unsynced: 0 }));
    view.rerender(show({ unsynced: 1, changes: 1 }));
    view.rerender(show({ unsynced: 0, changes: 1 }));
    act(() => { vi.advanceTimersByTime(SAVED_HOLD_MS - 50); });
    view.rerender(show({ unsynced: 1, changes: 1 }));
    view.rerender(show({ unsynced: 0, changes: 1 }));
    act(() => { vi.advanceTimersByTime(SAVED_HOLD_MS - 50); });
    expect(screen.getByRole('status').textContent).toBe('Saving');
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });

  it('shows a message or the offline text at once, without the moment', () => {
    const view = render(show({ unsynced: 1, changes: 1 }));
    expect(screen.getByRole('status').textContent).toBe('Saving');
    view.rerender(show({ unsynced: 1, changes: 1, offline: true, text: TEXTS.offline }, 'offline'));
    expect(screen.getByRole('status').textContent).toBe(TEXTS.offline);
    view.rerender(show({ text: TEXTS.busy }, 'connecting'));
    expect(screen.getByRole('status').textContent).toBe(TEXTS.busy);
  });

  it('changes its text without moving the focus', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const view = render(show({ unsynced: 1, changes: 1 }));
    view.rerender(show({ unsynced: 0, changes: 1 }));
    act(() => { vi.advanceTimersByTime(SAVED_HOLD_MS + 10); });
    view.rerender(show({ text: TEXTS.busy }, 'connecting'));
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('keeps the data-state the page styles by', () => {
    render(show({}, 'synced'));
    expect(screen.getByRole('status').getAttribute('data-state')).toBe('synced');
  });
});

describe('the connection manager counts the changes the server has not acknowledged', () => {
  it('starts at 0, follows the provider, and starts again at 0 with a new document', async () => {
    const h = harness();
    const manager = new ConnectionManager(h.options);
    manager.start();
    await flush();
    expect(manager.state().unsynced).toBe(0);
    h.last().provider.emit({ type: 'unsynced', count: 1 }); // around the connect: not a change of the person's
    h.last().provider.emit({ type: 'unsynced', count: 0 });
    expect(manager.state().changes).toBe(0);
    h.last().provider.emit({ type: 'synced' });
    h.last().provider.emit({ type: 'unsynced', count: 2 });
    expect(manager.state().unsynced).toBe(2);
    h.last().provider.emit({ type: 'unsynced', count: 0 });
    expect(manager.state().unsynced).toBe(0);
    expect(manager.state().changes).toBe(1); // counted: a change that is acknowledged before a screen draws is still known
    h.last().provider.emit({ type: 'unsynced', count: 5 });
    h.last().provider.emit({ type: 'stateless', payload: JSON.stringify({ grimoire: 1, kind: 'refusal', code: 'stale-epoch' }) });
    await flush();
    expect(manager.state().unsynced).toBe(0);
  });
});
