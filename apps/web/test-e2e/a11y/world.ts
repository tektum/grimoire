import { randomUUID } from 'node:crypto';
import { buildDevToken, type DevRole } from '../../test/support/dev-token';
import { sitAndLeave, waitForRevision } from '../history/revisions';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import type { Browser } from '@playwright/test';

/** What the tour needs on the stack: a collection with pages, a page in the trash, a group with a member, and a person to change the role of. */
export interface World {
  readonly collectionId: string;
  readonly alpha: { id: string; path: string; title: string };
  readonly beta: { id: string; path: string; title: string };
  /** The person whose role the keyboard walk changes, as the users screen names them. */
  readonly colleague: { id: string; name: string };
  readonly groupId: string;
  /** A saved version of Alpha (recorded by `recordRevision`: the server makes one when the last editor leaves). */
  revisionId: string;
}

const bearer = (userId: string, role: DevRole): Record<string, string> => ({ Authorization: `Bearer ${buildDevToken(devSecret(), userId, role)}` });

/** One call to the API as a development person; the first call of a person makes the server know them. */
export async function api<T>(userId: string, role: DevRole, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { ...bearer(userId, role), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const ADMIN = 'e2e-admin';

/** Makes the stack's side of the tour, through the API as the administrator. Each call makes new things, so a tour can be run again on the same stack. */
export async function buildWorld(): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  await api(ADMIN, 'admin', 'GET', '/v1/me');
  const collection = await api<{ id: string }>(ADMIN, 'admin', 'POST', '/v1/collections', { name: `Tour ${tag}`, defaultPermission: 'read_write' });
  const page = async (title: string, markdown: string) => {
    const made = await api<{ id: string; urlId: string }>(ADMIN, 'admin', 'POST', '/v1/pages', { collectionId: collection.id, title, markdown });
    return { id: made.id, title, path: `/p/page-${made.urlId}` };
  };
  const alpha = await page(`Alpha ${tag}`, '# Alpha\n\nA first paragraph with some words.\n\nA second paragraph.\n');
  const beta = await page(`Beta ${tag}`, 'The beta page.\n');
  const gone = await page(`Gone ${tag}`, 'Taken to the trash.\n');
  await api(ADMIN, 'admin', 'DELETE', `/v1/pages/${gone.id}`);
  const colleagueId = `e2e-colleague-${tag}`;
  const me = await api<{ id: string; name: string }>(colleagueId, 'member', 'GET', '/v1/me');
  const group = await api<{ id: string }>(ADMIN, 'admin', 'POST', '/v1/groups', { name: `Tour group ${tag}` });
  await api(ADMIN, 'admin', 'PUT', `/v1/groups/${group.id}/members/${me.id}`);
  return { collectionId: collection.id, alpha, beta, colleague: { id: me.id, name: me.name }, groupId: group.id, revisionId: '' };
}

/** Gives Alpha a saved version: a person sits at the page, adds a line and leaves, and the server records it. */
export async function recordRevision(browser: Browser, baseURL: string | undefined, world: World): Promise<void> {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
  try {
    await signInAs(context, 'e2e-admin', 'admin');
    await sitAndLeave(await context.newPage(), world.alpha.path, ' A line added in a sitting.');
  } finally {
    await context.close();
  }
  world.revisionId = await waitForRevision(world.alpha.id, (markdown) => markdown.includes('A line added in a sitting.'));
}

/** The whole world of a tour: the things on the stack, and a saved version of Alpha. */
export async function prepareWorld(browser: Browser, baseURL: string | undefined): Promise<World> {
  const world = await buildWorld();
  await recordRevision(browser, baseURL, world);
  return world;
}
