import type { Page } from '@playwright/test';
import type { DevRole } from '../../test/support/dev-token';
import { waitForSynced } from '../support/sync';
import { headingVisible } from './support';
import type { World } from './world';

/** One stop of the tour: a route of the route table, visited as someone, once the screen has what it shows. */
export interface Stop {
  /** The route as the route table writes it (`/c/:collectionId`), or `/` for the redirect. */
  readonly route: string;
  readonly who: 'nobody' | DevRole;
  readonly path: (world: World) => string;
  /** What to wait for once the page is open (the default is a first-level heading). */
  readonly ready?: (page: Page, world: World) => Promise<void>;
  /** The task whose screen is not built yet: the route shows a placeholder, and the stop says so in the report until the screen lands (then the mark goes and its own steps come). */
  readonly pending?: string;
}

/** Every route of the route table (contracts section 3), each with the page it is visited at. The tour fails when the route table has a route that is not here. */
export const STOPS: readonly Stop[] = [
  { route: '/login', who: 'nobody', path: () => '/login' },
  { route: '/', who: 'member', path: () => '/', ready: async (page) => void (await page.waitForURL(/\/c\//)) },
  { route: '/collections/new', who: 'admin', path: () => '/collections/new', ready: async (page) => void (await page.getByRole('button', { name: 'Create collection' }).waitFor()) },
  { route: '/c/:collectionId', who: 'member', path: (w) => `/c/${w.collectionId}`, ready: async (page, w) => void (await page.getByRole('link', { name: w.alpha.title }).waitFor()) },
  { route: '/p/:slug', who: 'member', path: (w) => w.alpha.path, ready: async (page) => waitForSynced(page) },
  { route: '/p/:slug/history', who: 'member', path: (w) => `${w.alpha.path}/history` },
  { route: '/p/:slug/history/:revisionId', who: 'member', path: (w) => `${w.alpha.path}/history/${w.revisionId}` },
  { route: '/search', who: 'member', path: () => '/search?q=paragraph' },
  { route: '/trash', who: 'member', path: () => '/trash' },
  { route: '/import', who: 'member', path: () => '/import' },
  { route: '/admin/users', who: 'admin', path: () => '/admin/users' },
  { route: '/admin/groups', who: 'admin', path: () => '/admin/groups' },
  {
    route: '/admin/collections/:id/access',
    who: 'admin',
    path: (w) => `/admin/collections/${w.collectionId}/access`,
    ready: async (page) => void (await page.getByRole('table', { name: 'Who has access' }).getByRole('row').nth(1).waitFor()),
  },
  { route: '/help', who: 'member', path: () => '/help' },
  { route: '*', who: 'member', path: () => '/nowhere/at/all' },
];

/** What a placeholder screen says: a stop marked `pending` shows it, and a stop that is not marked must not. */
export const PLACEHOLDER_TEXT = 'This screen is not built yet.';

/** A stop that is not ready fails naming the route, the address and what the page says in its place (a server that could not be reached shows as that sentence, not as a missing heading). */
export const stopReady = async (stop: Stop, page: Page, world: World): Promise<void> => {
  try {
    await (stop.ready ?? headingVisible)(page, world);
    await headingVisible(page);
  } catch (error) {
    const said = ((await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || 'nothing').replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`stop ${stop.route} (${page.url()}) is not ready; the page says: "${said}"`, { cause: error });
  }
};
