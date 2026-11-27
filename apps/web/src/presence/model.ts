import type { HocuspocusProvider } from '@hocuspocus/provider';

/** The awareness of a page's provider, as far as presence reads it: who is connected and what they published. */
export interface AwarenessSource {
  readonly clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  on(event: 'change', listener: () => void): void;
  off(event: 'change', listener: () => void): void;
}

/** At most this many discs; the rest are one "+N" disc. */
export const MAX_DISCS = 4;
/** Up to this many people, their first names show in words beside the discs. */
export const NAMED_UP_TO = 2;

const idOf = (state: Record<string, unknown>): string | null => {
  const user = state['user'];
  if (typeof user !== 'object' || user === null || !('id' in user)) return null;
  return typeof user.id === 'string' && user.id !== '' ? user.id : null;
};

/**
 * The ids of the other people on the page, each once (a person with two tabs is one person), in the order they appear in the awareness.
 * This tab and every other tab of the signed-in person are left out: you are not shown in your own stack.
 */
export function othersOf(source: AwarenessSource, self: string | null): string[] {
  const ids: string[] = [];
  for (const [clientId, state] of source.getStates()) {
    if (clientId === source.clientID) continue;
    const id = idOf(state);
    if (id === null || id === self || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** The awareness of a session, when it has one (the live provider's session does; a test's fake may not). */
export function awarenessOf(session: object): AwarenessSource | null {
  if (!('awareness' in session)) return null;
  // The live session's awareness is the provider's own (real-provider.ts): typed by the SDK, so that the assignment below fails to compile if it stops fitting AwarenessSource.
  const awareness: AwarenessSource | null = (session as Partial<Pick<HocuspocusProvider, 'awareness'>>).awareness ?? null;
  return awareness;
}

const words = (name: string): string[] => name.split(' ').filter((w) => w !== '');

/** One or two letters for a disc: the first letters of the first and the last word of the name. */
export function initialsOf(name: string): string {
  const parts = words(name);
  const first = Array.from(parts[0] ?? '?')[0]!;
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1]!)[0]! : '';
  return (first + last).toUpperCase();
}

/** "Tomas, Priya": the first word of each name. */
export function firstNames(names: readonly string[]): string {
  return names.map((name) => words(name)[0] ?? name).join(', ');
}

const list = (names: readonly string[]): string => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`);

/** One sentence for who came and went since the last announcement ("Priya joined", "Priya and Tomas joined, Ana left"); null when nothing changed. */
export function announcementOf(joined: readonly string[], left: readonly string[]): string | null {
  const parts: string[] = [];
  if (joined.length > 0) parts.push(`${list(joined)} joined`);
  if (left.length > 0) parts.push(`${list(left)} left`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** Brings a person's caret into view in the editor: the remote caret carries their id. False when they have no caret on the page. */
export function jumpTo(root: ParentNode | null, id: string): boolean {
  if (root === null) return false;
  for (const caret of root.querySelectorAll<HTMLElement>('.ProseMirror-yjs-cursor')) {
    if (caret.dataset['userId'] !== id) continue;
    caret.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  }
  return false;
}
