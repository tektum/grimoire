import { describe, expect, it } from 'vitest';
import { presenceAwareness, type AwarenessLike } from '../../src/editor/core/awareness';
import { FakeClock } from './support';

/** A stand-in for the real awareness: it records each update (one `setLocalState` is one update on the wire). */
class FakeAwareness implements AwarenessLike {
  state: Record<string, unknown> | null = {};
  readonly sent: { at: number; state: Record<string, unknown> | null }[] = [];
  readonly clientID = 7;
  destroyed = false;
  constructor(private readonly clock: FakeClock) {}
  getLocalState() {
    return this.state;
  }
  setLocalState(state: Record<string, unknown> | null) {
    this.state = state;
    this.sent.push({ at: this.clock.now(), state });
  }
  setLocalStateField(field: string, value: unknown) {
    this.setLocalState({ ...(this.state ?? {}), [field]: value });
  }
  getStates() {
    return new Map([[1, { user: { id: 'x' } }]]);
  }
  destroy() {
    this.destroyed = true;
  }
}

const make = (userId: string | null = null) => {
  const clock = new FakeClock();
  const awareness = new FakeAwareness(clock);
  const wrapped = presenceAwareness(awareness, { userId: () => userId, timers: clock });
  return { clock, awareness, wrapped };
};

describe('the awareness the editor publishes through', () => {
  it('sends at most 4 updates in any second for 100 selection changes, and the last one is the newest cursor', async () => {
    const { clock, awareness, wrapped } = make();
    for (let i = 0; i < 100; i++) {
      wrapped.setLocalStateField('cursor', { anchor: i, head: i });
      await clock.advance(10); // 100 changes in 1 s
    }
    await clock.advance(1000);
    const starts = awareness.sent.map((s) => s.at);
    for (const first of starts) expect(starts.filter((t) => t >= first && t < first + 1000).length).toBeLessThanOrEqual(4);
    expect(awareness.sent.length).toBeGreaterThanOrEqual(4); // not silent either: the first goes at once, then one a quarter second
    expect(awareness.state).toEqual({ cursor: { anchor: 99, head: 99 } });
  });

  it('sends the first change at once and holds the next until a quarter of a second has passed', async () => {
    const { clock, awareness, wrapped } = make();
    wrapped.setLocalStateField('cursor', 1);
    expect(awareness.sent).toHaveLength(1);
    wrapped.setLocalStateField('cursor', 2);
    expect(awareness.sent).toHaveLength(1);
    await clock.advance(249);
    expect(awareness.sent).toHaveLength(1);
    await clock.advance(1);
    expect(awareness.sent).toHaveLength(2);
    expect(awareness.state).toEqual({ cursor: 2 });
  });

  it('puts several fields that changed together into one update', async () => {
    const { clock, awareness, wrapped } = make();
    wrapped.setLocalStateField('cursor', 0);
    wrapped.setLocalStateField('cursor', 1);
    wrapped.setLocalStateField('blockId', 'b1');
    await clock.advance(250);
    expect(awareness.sent).toHaveLength(2);
    expect(awareness.state).toEqual({ cursor: 1, blockId: 'b1' });
  });

  it('publishes only the id of the user, whatever the editor writes: a name and a colour never go out', async () => {
    const { awareness, wrapped } = make('user-1');
    wrapped.setLocalStateField('user', { id: 'someone-else', name: 'Forged', color: '#ff0000' });
    expect(awareness.state).toEqual({ user: { id: 'user-1' } });
    wrapped.setLocalState({ user: { name: 'Forged', color: '#ff0000' } });
    expect(JSON.stringify(awareness.state)).not.toContain('Forged');
  });

  it('adds the id to the first update once it is known: an id that arrived after the editor is still published', async () => {
    const clock = new FakeClock();
    const awareness = new FakeAwareness(clock);
    let id: string | null = null;
    const wrapped = presenceAwareness(awareness, { userId: () => id, timers: clock });
    wrapped.setLocalStateField('cursor', 1);
    expect(awareness.state).toEqual({ cursor: 1 });
    id = 'user-1';
    wrapped.setLocalStateField('cursor', 2);
    await clock.advance(250);
    expect(awareness.state).toEqual({ cursor: 2, user: { id: 'user-1' } });
  });

  it('does not publish a user while the id is not known', async () => {
    const { awareness, wrapped } = make(null);
    wrapped.setLocalStateField('user', { name: 'Forged' });
    expect(awareness.sent).toHaveLength(0);
  });

  it('drops every other field: only user, cursor and blockId are published', async () => {
    const { clock, awareness, wrapped } = make();
    wrapped.setLocalStateField('name', 'Forged');
    wrapped.setLocalStateField('color', '#ff0000');
    wrapped.setLocalState({ cursor: 3, avatar: 'x', secret: 1 });
    await clock.advance(1000);
    expect(awareness.state).toEqual({ cursor: 3 });
  });

  it('reads back what is waiting, so the editor does not write the same thing twice', () => {
    const { wrapped } = make();
    wrapped.setLocalStateField('cursor', 1);
    wrapped.setLocalStateField('cursor', 2); // held
    expect(wrapped.getLocalState()).toEqual({ cursor: 2 });
  });

  it('leaving is sent at once and nothing waiting is sent after it', async () => {
    const { clock, awareness, wrapped } = make();
    wrapped.setLocalStateField('cursor', 1);
    wrapped.setLocalStateField('cursor', 2); // held
    wrapped.setLocalState(null);
    await clock.advance(1000);
    expect(awareness.state).toBeNull();
    expect(awareness.sent.at(-1)!.state).toBeNull();
    expect(clock.pendingCount()).toBe(0);
  });

  it('hands every other part of the awareness through, and destroys with nothing left waiting', async () => {
    const { clock, awareness, wrapped } = make();
    expect(wrapped.clientID).toBe(7);
    expect(wrapped.getStates().get(1)).toEqual({ user: { id: 'x' } });
    wrapped.setLocalStateField('cursor', 1);
    wrapped.setLocalStateField('cursor', 2);
    (wrapped as unknown as { destroy(): void }).destroy();
    expect(awareness.destroyed).toBe(true);
    expect(clock.pendingCount()).toBe(0);
  });

  it('uses the platform timers when none are given', () => {
    const awareness = new FakeAwareness(new FakeClock());
    const wrapped = presenceAwareness(awareness, { userId: () => 'u' });
    wrapped.setLocalStateField('cursor', 1);
    expect(awareness.sent).toHaveLength(1);
  });
});
