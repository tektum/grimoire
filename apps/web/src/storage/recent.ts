import { createClientStorage, type ClientStorage } from '.';

/** The pages this person opened last, kept in this browser (local storage, one list per person, all in one key), newest first, at most {@link RECENT_MAX}. Nothing is sent anywhere. */
export interface RecentPage {
  readonly id: string;
  readonly urlId: string;
  readonly title: string;
  /** What the row says under the title: the parent page; empty for a page at the top of its collection (the collection's name is then looked up by `collectionId`). */
  readonly path: string;
  readonly collectionId?: string;
}

export const RECENT_MAX = 8;
/** One key for every person's list: a sign-out takes it away whole, with nothing to keep in step with it. */
const KEY = 'recent';
const browser = createClientStorage();

const isRecent = (value: unknown): value is RecentPage => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && typeof v['urlId'] === 'string' && typeof v['title'] === 'string' && typeof v['path'] === 'string' && (v['collectionId'] === undefined || typeof v['collectionId'] === 'string');
};

/** Everyone's lists, or none when there are none, the browser keeps nothing (storage blocked) or what is kept is not of this shape. */
function readAll(storage: ClientStorage): Record<string, RecentPage[]> {
  try {
    const parsed: unknown = JSON.parse(storage.get(KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([id, list]) => [id, Array.isArray(list) ? list.filter(isRecent).slice(0, RECENT_MAX) : []]));
  } catch {
    return {};
  }
}

export function readRecent(userId: string, storage: ClientStorage = browser): RecentPage[] {
  return readAll(storage)[userId] ?? [];
}

/** What a row says under a page: the title of its parent ("Untitled" for a parent that has none), nothing at the top of a collection. */
export const recentPath = (breadcrumb: readonly { readonly title: string }[] | undefined): string => {
  const parent = breadcrumb?.at(-1);
  return parent === undefined ? '' : parent.title === '' ? 'Untitled' : parent.title;
};

/** Puts a page first (a page opened again moves up, it is not listed twice). Storage that is blocked or full just means no list. */
export function recordRecent(userId: string, page: RecentPage, storage: ClientStorage = browser): void {
  const all = readAll(storage);
  all[userId] = [page, ...(all[userId] ?? []).filter((p) => p.id !== page.id)].slice(0, RECENT_MAX);
  storage.set(KEY, JSON.stringify(all));
}

/** Takes a page out of one person's list: it could not be opened (removed, or no longer theirs to read), so the palette must not offer it. */
export function removeRecent(userId: string, urlId: string, storage: ClientStorage = browser): void {
  const all = readAll(storage);
  const kept = all[userId] ?? [];
  const next = kept.filter((p) => p.urlId !== urlId);
  if (next.length === kept.length) return;
  all[userId] = next;
  storage.set(KEY, JSON.stringify(all));
}

/** Takes every list away: on sign-out, so that the next person on a shared machine does not see what was opened. */
export function clearRecent(storage: ClientStorage = browser): void {
  storage.remove(KEY);
}
