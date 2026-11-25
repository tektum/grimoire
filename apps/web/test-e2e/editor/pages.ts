import { randomUUID } from 'node:crypto';
import { buildDevToken } from '../../test/support/dev-token';
import { apiUrl, devSecret } from '../support/env';

export interface MadePage {
  readonly id: string;
  readonly urlId: string;
  readonly collectionId: string;
  /** The name of the collection (what the import screen lists it as). */
  readonly collectionName: string;
  /** The address of the page in the app. */
  readonly path: string;
}

/** The first call of a person provisions their row, with the role of their token: the administrator makes themselves known to the server before anything else (a collection by someone it does not know yet is refused). */
let administrator: Promise<void> | undefined;
function provisionAdministrator(): Promise<void> {
  administrator ??= (async () => {
    const response = await fetch(`${apiUrl()}/v1/me`, { headers: { Authorization: `Bearer ${buildDevToken(devSecret(), 'e2e-admin', 'admin')}` } });
    if (!response.ok) throw new Error(`GET /v1/me as the administrator answered ${response.status}`);
    const me = (await response.json()) as { role?: string };
    if (me.role !== 'admin') throw new Error(`the administrator of the specs has the role ${String(me.role)}`);
  })();
  return administrator;
}

async function call<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  await provisionAdministrator();
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${buildDevToken(devSecret(), 'e2e-admin', 'admin')}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/**
 * A collection and a page in it with this Markdown, made through the API as an administrator. `permission` is the collection's default
 * for everyone else: `read_write` lets the e2e users edit, `read` makes them readers.
 */
export async function makePage(markdown: string, options: { title?: string; permission?: 'read' | 'read_write' } = {}): Promise<MadePage> {
  const name = `e2e ${randomUUID().slice(0, 8)}`;
  const collection = await call<{ id: string }>('POST', '/v1/collections', { name, defaultPermission: options.permission ?? 'read_write' });
  const page = await call<{ id: string; urlId: string }>('POST', '/v1/pages', { collectionId: collection.id, markdown, title: options.title ?? 'Editor page' });
  return { id: page.id, urlId: page.urlId, collectionId: collection.id, collectionName: name, path: `/p/page-${page.urlId}` };
}

/** `count` pages in one new collection, each with the title and the Markdown `make` gives for its number: for a specification that needs more results than a page of a list holds. */
export async function makePagesIn(count: number, make: (n: number) => { title: string; markdown: string }, options: { permission?: 'read' | 'read_write' } = {}): Promise<{ collectionId: string; collectionName: string; pages: { id: string; urlId: string; title: string }[] }> {
  const name = `e2e ${randomUUID().slice(0, 8)}`;
  const collection = await call<{ id: string }>('POST', '/v1/collections', { name, defaultPermission: options.permission ?? 'read_write' });
  const pages: { id: string; urlId: string; title: string }[] = [];
  for (let n = 0; n < count; n += 1) {
    const { title, markdown } = make(n);
    const page = await call<{ id: string; urlId: string }>('POST', '/v1/pages', { collectionId: collection.id, markdown, title });
    pages.push({ id: page.id, urlId: page.urlId, title });
  }
  return { collectionId: collection.id, collectionName: name, pages };
}

/** Changes what everyone without an entry of their own may do in a collection (`null`: nothing), as an administrator. The open editors of its pages learn of it at the server's next access check. */
export async function setDefaultPermission(collectionId: string, permission: 'read' | 'read_write' | null): Promise<void> {
  await call('PATCH', `/v1/collections/${collectionId}`, { defaultPermission: permission });
}

/** Suspends or unsuspends a person, as an administrator: a suspended person has no access to anything, and the server refuses their sockets with `forbidden`. */
export async function setSuspended(userId: string, suspended: boolean): Promise<void> {
  await call('PATCH', `/v1/users/${userId}`, { suspended });
}

/** Changes a person's role (`admin`, `member`, `viewer`), as an administrator. The server's check of open connections sees it at its next round. */
export async function setRole(userId: string, role: 'admin' | 'member' | 'viewer'): Promise<void> {
  await call('PATCH', `/v1/users/${userId}`, { role });
}

/** Resets the saved state of a page as an administrator (`POST /v1/pages/{id}/reset-state`); every open editor of the page is closed with a stale epoch. */
export async function resetPageState(pageId: string, options: { confirmStale?: boolean; markdown?: string } = {}): Promise<void> {
  await call('POST', `/v1/pages/${pageId}/reset-state`, {
    ...(options.confirmStale === true ? { confirmStale: true } : {}),
    ...(options.markdown === undefined ? {} : { markdown: options.markdown }),
  });
}

const admin = (): Record<string, string> => ({ Authorization: `Bearer ${buildDevToken(devSecret(), 'e2e-admin', 'admin')}` });

/** The page as the API gives it (its state epoch among the rest). */
export async function readPage(pageId: string): Promise<{ stateEpoch: number; markdownStale: boolean }> {
  const response = await fetch(`${apiUrl()}/v1/pages/${pageId}`, { headers: admin() });
  if (!response.ok) throw new Error(`GET /v1/pages/${pageId} answered ${response.status}`);
  return (await response.json()) as { stateEpoch: number; markdownStale: boolean };
}

/** The saved Markdown of the page, as the export gives it. */
export async function readMarkdown(pageId: string): Promise<string> {
  const response = await fetch(`${apiUrl()}/v1/pages/${pageId}/markdown`, { headers: admin() });
  if (!response.ok) throw new Error(`GET /v1/pages/${pageId}/markdown answered ${response.status}`);
  return response.text();
}

/** Takes the page out of the trash for good: it moves to the trash and is purged, so the server no longer knows the id. */
export async function removePageForGood(pageId: string): Promise<void> {
  await call<void>('DELETE', `/v1/pages/${pageId}`);
  await call<void>('DELETE', `/v1/trash/${pageId}`);
}

/** The signed-in person as the server knows them: the id presence uses, and the name the directory gives for it. */
export async function whoIs(userId: string): Promise<{ id: string; name: string }> {
  const response = await fetch(`${apiUrl()}/v1/me`, { headers: { Authorization: `Bearer ${buildDevToken(devSecret(), userId, 'member')}` } });
  if (!response.ok) throw new Error(`GET /v1/me answered ${response.status}`);
  return (await response.json()) as { id: string; name: string };
}

/** The status the API gives an administrator for the page: 404 for an id the server no longer knows. */
export async function pageStatus(pageId: string): Promise<number> {
  return (await fetch(`${apiUrl()}/v1/pages/${pageId}`, { headers: admin() })).status;
}
