import { expect, type Page } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { SCRIPTED_PAGE_ID, SCRIPTED_URL_ID } from '../editor/scripted';
import { signInAs } from '../support/sign-in';

// What the screenshots of the page screen share. The editor joins a collaboration server only when `E2E_SHOT_COLLAB` (its address) is set: the pages here are the stand-in API's, which a real
// server does not know, so the shots are taken with a collaboration server that accepts these two pages (SAVED_PAGE: with a text; EMPTY_PAGE: an empty document, as a new page is). Without it
// the status line says "Connecting…", which the specifications that use this do not look at.
export const COLLAB = process.env['E2E_SHOT_COLLAB'];
export const SAVED_PAGE = { id: SCRIPTED_PAGE_ID, urlId: SCRIPTED_URL_ID };
export const EMPTY_PAGE = { id: '22222222-2222-4222-8222-222222222222', urlId: 'new00001' };

export const p = (id: string, parentId: string | null, position: string, title: string, urlId = id.padEnd(8, '0')) => ({ id, urlId, parentId, position, title, icon: null });

/** The page is settled: the tree is drawn, the person's name is shown and, with a collaboration server, the editor has joined. `E2E_SHOT_FONT` (a font stack) stands in for the interface font where the machine has none that looks like the product's. */
export async function settled(page: Page, tree: number): Promise<void> {
  await expect(page.getByRole('treeitem')).toHaveCount(tree);
  await expect(page.getByText('Alice Archer')).toBeVisible();
  if (COLLAB !== undefined) await expect(page.getByTestId('editor-root')).toHaveAttribute('data-collab-state', 'synced');
  const font = process.env['E2E_SHOT_FONT'];
  if (font !== undefined) await page.addStyleTag({ content: `:root { --font-ui: ${font}; }` });
}

/** Signs in (with a real token when there is a collaboration server: it checks the token) and stands in for the API. `firstNew` is the page that "New page" makes. */
export async function openShots(page: Page, context: Parameters<typeof signInAs>[0], pages: ReturnType<typeof p>[], options: { role?: 'admin' | 'member'; firstNew?: { id: string; urlId: string } } = {}): Promise<void> {
  const role = options.role ?? 'member';
  await signInAs(context, 'e2e-alice', role, { check: COLLAB !== undefined });
  await mockApi(page, {
    collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }],
    pages,
    userName: 'Alice Archer',
    role,
    ...(options.firstNew === undefined ? {} : { firstNewPageId: options.firstNew.id, firstNewPageUrlId: options.firstNew.urlId }),
    ...(COLLAB === undefined ? {} : { collabUrl: COLLAB }),
  });
}
