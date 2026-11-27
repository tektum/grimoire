import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Directory } from '../../src/editor/core/directory';
import { ANNOUNCE_DELAY_MS, PresenceAnnouncer, PresenceStack, usePresence, type AwarenessSource, type Person, type PresenceSource } from '../../src/presence';
import { announcementOf, awarenessOf, firstNames, initialsOf, jumpTo, othersOf } from '../../src/presence/model';
import { COLLAB_COLOURS, colourIndex, labelText } from '../../src/ui/collab';
import '../support/dom';

const ME = 'me';

class FakeAwareness implements AwarenessSource {
  readonly clientID = 1;
  readonly states = new Map<number, Record<string, unknown>>([[1, { user: { id: ME } }]]);
  readonly listeners = new Set<() => void>();
  getStates() { return this.states; }
  on(_event: 'change', listener: () => void) { this.listeners.add(listener); }
  off(_event: 'change', listener: () => void) { this.listeners.delete(listener); }
  /** A client's state (null: it left), then the change event, as the provider sends it. */
  set(clientId: number, state: Record<string, unknown> | null) {
    if (state === null) this.states.delete(clientId);
    else this.states.set(clientId, state);
    act(() => { for (const listener of this.listeners) listener(); });
  }
}

function fakeDirectory(names: Record<string, string>) {
  const listeners = new Set<() => void>();
  const known = new Map(Object.entries(names));
  const directory: Directory & { requested: string[][]; learn(id: string, name: string): void; listeners: Set<() => void> } = {
    requested: [],
    listeners,
    nameOf: (id) => known.get(id) ?? 'Someone',
    request: (ids) => void directory.requested.push([...ids]),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    learn(id, name) {
      known.set(id, name);
      act(() => { for (const listener of listeners) listener(); });
    },
  };
  return directory;
}

const person = (id: string, name: string): Person => ({ id, name, colour: colourIndex(id) });

describe('presence: the model', () => {
  it('lists the others once each, in order, leaving out this tab, the signed-in person and states without an id', () => {
    const source = new FakeAwareness();
    source.states.set(2, { user: { id: 'priya' } });
    source.states.set(3, { user: { id: ME } }); // my other tab
    source.states.set(4, { user: { id: 'tomas' } });
    source.states.set(5, { user: { id: 'priya' } }); // her other tab
    source.states.set(6, { cursor: null });
    source.states.set(7, { user: 'tomas' });
    source.states.set(8, { user: { id: '' } });
    source.states.set(9, { user: { name: 'x' } });
    expect(othersOf(source, ME)).toEqual(['priya', 'tomas']);
    expect(othersOf(source, null)).toEqual(['priya', ME, 'tomas']); // before the signed-in id is known only this tab is left out
  });

  it('finds the awareness of a live session, and none on a session without one', () => {
    const awareness = new FakeAwareness();
    expect(awarenessOf({ awareness })).toBe(awareness);
    expect(awarenessOf({ provider: {} })).toBeNull();
  });

  it('makes initials from the first and last word, and first names from the first word', () => {
    expect(initialsOf('Priya Raman')).toBe('PR');
    expect(initialsOf('tomas')).toBe('T');
    expect(initialsOf('Ana Maria de Souza')).toBe('AS');
    expect(initialsOf('')).toBe('?');
    expect(firstNames(['Tomas Berg', 'Priya Raman'])).toBe('Tomas, Priya');
    expect(firstNames([''])).toBe('');
  });

  it('says who joined and who left in one sentence', () => {
    expect(announcementOf(['Priya'], [])).toBe('Priya joined');
    expect(announcementOf([], ['Priya'])).toBe('Priya left');
    expect(announcementOf(['Priya', 'Tomas'], ['Ana'])).toBe('Priya and Tomas joined, Ana left');
    expect(announcementOf(['A', 'B', 'C'], [])).toBe('A, B and C joined');
    expect(announcementOf([], [])).toBeNull();
  });

  it("jumps to a person's caret: the remote caret with their id is scrolled into view", () => {
    const root = document.createElement('div');
    root.innerHTML = '<p><span class="ProseMirror-yjs-cursor" data-user-id="tomas"></span>text<span class="ProseMirror-yjs-cursor" data-user-id="priya"></span></p>';
    const carets = [...root.querySelectorAll<HTMLElement>('.ProseMirror-yjs-cursor')];
    for (const caret of carets) caret.scrollIntoView = vi.fn();
    expect(jumpTo(root, 'priya')).toBe(true);
    expect(carets[1]!.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
    expect(carets[0]!.scrollIntoView).not.toHaveBeenCalled();
    expect(jumpTo(root, 'ana')).toBe(false); // no caret on the page yet
    expect(jumpTo(null, 'priya')).toBe(false);
  });
});

describe('the presence stack', () => {
  afterEach(cleanup);

  it('renders nothing when nobody else is here', () => {
    const { container } = render(<PresenceStack people={[]} onJump={() => undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('is a button per person, named after them with the name as tooltip, in their colour, and their first names in words when two or fewer are here', () => {
    render(<PresenceStack people={[person('tomas', 'Tomas Berg'), person('priya', 'Priya Raman')]} onJump={() => undefined} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Tomas Berg', 'Priya Raman']);
    expect(screen.getByRole('button', { name: 'Priya Raman' }).getAttribute('title')).toBe('Priya Raman');
    expect(buttons.map((b) => b.textContent)).toEqual(['TB', 'PR']);
    const colour = colourIndex('priya');
    expect(buttons[1]!.style.getPropertyValue('--presence-colour')).toBe(`var(--collab-${String(colour)})`);
    expect(buttons[1]!.style.getPropertyValue('--presence-text')).toBe(labelText(COLLAB_COLOURS[colour]!));
    const words = document.querySelector('.presence-names');
    expect(words?.textContent).toBe('Tomas, Priya');
    expect(words?.getAttribute('aria-hidden')).toBe('true'); // the buttons already carry the names
  });

  it('shows no names in words for three or more people', () => {
    render(<PresenceStack people={[person('a', 'Ana'), person('b', 'Bo'), person('c', 'Cy')]} onJump={() => undefined} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(document.querySelector('.presence-names')).toBeNull();
    expect(document.querySelector('.presence-more')).toBeNull();
  });

  it('shows at most four discs, then one "+N" disc that names the rest', () => {
    const people = ['Ana', 'Bo', 'Cy', 'Di', 'Ed', 'Flo'].map((name) => person(name.toLowerCase(), name));
    render(<PresenceStack people={people} onJump={() => undefined} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Ana', 'Bo', 'Cy', 'Di']);
    const more = screen.getByRole('img', { name: 'Ed, Flo' });
    expect(more.textContent).toBe('+2');
    expect(more.getAttribute('title')).toBe('Ed, Flo');
  });

  it("jumps to a person's place when their disc is pressed", async () => {
    const onJump = vi.fn();
    render(<PresenceStack people={[person('priya', 'Priya')]} onJump={onJump} />);
    await userEvent.click(screen.getByRole('button', { name: 'Priya' }));
    expect(onJump).toHaveBeenCalledWith('priya');
  });
});

describe('who is here, and the announcement of who came and went', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  function Host({ initial }: { initial: PresenceSource | null }) {
    const [presence] = useState(initial);
    const { people, announcement } = usePresence(presence, ME);
    return (
      <>
        <PresenceStack people={people} onJump={() => undefined} />
        <PresenceAnnouncer text={announcement} />
      </>
    );
  }
  const names = () => screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label'));
  const said = () => screen.getByRole('status').textContent;

  it('is one polite live region of its own', () => {
    render(<PresenceAnnouncer text="" />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
  });

  it('shows nobody without a source', () => {
    render(<Host initial={null} />);
    expect(names()).toEqual([]);
  });

  it('shows the people already here without announcing them, and asks the directory for their names', () => {
    const source = new FakeAwareness();
    source.states.set(2, { user: { id: 'priya' } });
    const directory = fakeDirectory({ priya: 'Priya Raman' });
    render(<Host initial={{ source, directory }} />);
    expect(names()).toEqual(['Priya Raman']);
    expect(directory.requested.at(-1)).toEqual(['priya']);
    act(() => { vi.advanceTimersByTime(ANNOUNCE_DELAY_MS * 2); });
    expect(said()).toBe('');
  });

  it('announces a join once, after a second of quiet, and not for a moving caret', () => {
    const source = new FakeAwareness();
    const directory = fakeDirectory({ priya: 'Priya Raman' });
    render(<Host initial={{ source, directory }} />);
    expect(screen.queryByRole('button')).toBeNull();
    source.set(2, { user: { id: 'priya' } });
    expect(names()).toEqual(['Priya Raman']); // the stack follows at once
    act(() => { vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 1); });
    expect(said()).toBe('');
    source.set(2, { user: { id: 'priya' }, cursor: { anchor: 1, head: 1 } }); // she types: nobody came or went
    act(() => { vi.advanceTimersByTime(1); });
    expect(said()).toBe('Priya Raman joined');
  });

  it('collapses several changes in the window into one sentence, and says nothing when they cancel out', () => {
    const source = new FakeAwareness();
    source.states.set(4, { user: { id: 'ana' } });
    const directory = fakeDirectory({ priya: 'Priya', tomas: 'Tomas', ana: 'Ana' });
    render(<Host initial={{ source, directory }} />);
    source.set(2, { user: { id: 'priya' } });
    act(() => { vi.advanceTimersByTime(500); });
    source.set(3, { user: { id: 'tomas' } });
    act(() => { vi.advanceTimersByTime(500); });
    source.set(4, null);
    act(() => { vi.advanceTimersByTime(ANNOUNCE_DELAY_MS - 1); });
    expect(said()).toBe(''); // still within the window: the last change started it again
    act(() => { vi.advanceTimersByTime(1); });
    expect(said()).toBe('Priya and Tomas joined, Ana left');
    source.set(5, { user: { id: 'ana' } });
    source.set(5, null);
    act(() => { vi.advanceTimersByTime(ANNOUNCE_DELAY_MS); });
    expect(said()).toBe('Priya and Tomas joined, Ana left'); // she came and went within the window: nothing new to say
    source.set(2, null);
    act(() => { vi.advanceTimersByTime(ANNOUNCE_DELAY_MS); });
    expect(said()).toBe('Priya left');
    expect(names()).toEqual(['Tomas']);
  });

  it('shows a name once the directory has it', () => {
    const source = new FakeAwareness();
    source.states.set(2, { user: { id: 'priya' } });
    const directory = fakeDirectory({});
    render(<Host initial={{ source, directory }} />);
    expect(names()).toEqual(['Someone']);
    directory.learn('priya', 'Priya');
    expect(names()).toEqual(['Priya']);
  });

  it('lets go of the awareness and the directory when it goes, and announces nothing after', () => {
    const source = new FakeAwareness();
    const directory = fakeDirectory({ priya: 'Priya' });
    const view = render(<Host initial={{ source, directory }} />);
    source.set(2, { user: { id: 'priya' } });
    view.unmount();
    expect(source.listeners.size).toBe(0);
    expect(directory.listeners.size).toBe(0);
    act(() => { vi.advanceTimersByTime(ANNOUNCE_DELAY_MS); }); // the timer went with it: no update on an unmounted component
  });

  it('puts the stack and the announcer in their own markup: the stack is in its own element, apart from the region', () => {
    const source = new FakeAwareness();
    source.states.set(2, { user: { id: 'priya' } });
    render(<Host initial={{ source, directory: fakeDirectory({ priya: 'Priya' }) }} />);
    const stack = document.querySelector('.presence');
    expect(stack).not.toBeNull();
    expect(within(stack as HTMLElement).queryByRole('status')).toBeNull();
  });
});
