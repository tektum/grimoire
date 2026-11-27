import { createClientStorage, type ClientStorage } from '.';

/** The pages this person opened last, kept in this browser (local storage, one list per person), newest first, at most {@link RECENT_MAX}. Nothing is sent anywhere. */
export interface RecentPage {
  readonly id: string;
  readonly urlId: string;
  readonly title: string;
  /** What the row says under the title: the parent page, or the collection. */
  readonly path: string;
}

export const RECENT_MAX = 8;
const keyOf = (userId: string): string => `recent.${userId}`;
const OWNERS = 'recent-owners';
const browser = createClientStorage();

const isRecent = (value: unknown): value is RecentPage => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && typeof v['urlId'] === 'string' && typeof v['title'] === 'string' && typeof v['path'] === 'string';
};

/** The list, or an empty one when there is none, the browser keeps nothing (storage blocked) or what is kept is not a list of pages. */
export function readRecent(userId: string, storage: ClientStorage = browser): RecentPage[] {
  try {
    const parsed: unknown = JSON.parse(storage.get(keyOf(userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Who has a list in this browser: so that signing out can take every one of them away (storage cannot be listed through {@link ClientStorage}). */
function ownersOf(storage: ClientStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.get(OWNERS) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Puts a page first (a page opened again moves up, it is not listed twice). Storage that is blocked or full just means no list. */
export function recordRecent(userId: string, page: RecentPage, storage: ClientStorage = browser): void {
  const next = [page, ...readRecent(userId, storage).filter((p) => p.id !== page.id)].slice(0, RECENT_MAX);
  storage.set(keyOf(userId), JSON.stringify(next));
  const owners = ownersOf(storage);
  if (!owners.includes(userId)) storage.set(OWNERS, JSON.stringify([...owners, userId]));
}

/** Takes every list away: on sign-out, so that the next person on a shared machine does not see what was opened. */
export function clearRecent(storage: ClientStorage = browser): void {
  for (const id of ownersOf(storage)) storage.remove(keyOf(id));
  storage.remove(OWNERS);
}
