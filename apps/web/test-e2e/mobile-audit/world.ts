import { expect, type BrowserContext, type Page } from '@playwright/test';
import { adminApi, type MockUser } from '../admin/mock-api';
import { API, mockApi } from '../collections/mock-api';
import { historyApi, PAGE_ID, SLUG, type MockRevision } from '../history/mock-api';
import { CONSTRUCT_REPORT, scriptedImports, type ScriptedItem } from '../import/support';
import { p } from '../page/shot-support';
import { hit, scriptedSearch } from '../search/support';
import { signInAs } from '../support/sign-in';
import { SANS } from './audit';

// The stand-in world of the audit: the same collections, tree and people on every screen, with long names where a phone would feel them.

export const COLLECTIONS = [
  { id: 'c1', name: 'Dev', myPermission: 'read-write' as const },
  { id: 'c2', name: 'Engineering handbook and runbooks', myPermission: 'read-write' as const },
  { id: 'c3', name: 'Private', myPermission: 'read-only' as const },
];
export const PAGES = [
  p('w1', null, 'p0000', 'Welcome'),
  p('g1', 'w1', 'p0000', 'Team handbook for new starters'),
  p('r1', 'g1', 'p0000', 'Runbooks and incident response'),
  { id: PAGE_ID, urlId: 'abc123', parentId: 'r1', position: 'p0000', title: 'Quarterly plan', icon: null },
  p('n1', null, 'p0001', 'Meeting notes from the architecture review of November'),
  p('m1', null, 'p0002', 'Plan for May'),
];

export const MARKDOWN = [
  '# Quarterly plan',
  '',
  'An incident is any unplanned event that stops people from using the service. This page is the short version; the longer background is in [the review template](https://example.invalid/review).',
  '',
  '## Goals',
  '',
  '- Ship the history screens and the restore.',
  '- Review the diff with the team before the end of the month.',
  '',
  'A long address with no place to break: https://example.invalid/a/very/long/path/that/does/not/break/anywhere/at/all/0123456789abcdef0123456789abcdef',
  '',
  '| Owner | Area | Status | Due | Notes |',
  '| --- | --- | --- | --- | --- |',
  '| Alice Example | Search | In progress | 2026-12-01 | Waiting on the index rebuild |',
  '| Bob Builder | Import | Done | 2026-11-20 | Shipped behind the flag |',
  '',
  '```',
  'const result = await client.collections.tree(collectionId, { includeArchived: false, depth: 10 });',
  '```',
  '',
  '> A quote that sits in the reading column.',
  '',
  '## Notes',
  '',
  ...Array.from({ length: 6 }, (_, i) => `Paragraph ${String(i + 1)} of the notes, long enough to wrap twice on a phone so that the page scrolls past the top bar.\n`),
  '### Deep heading',
  '',
  'End.',
  '',
].join('\n');

const at = (day: number, hour: number, minute: number) => Date.UTC(2026, 10, day, hour, minute);
const alice = { id: 'u1', name: 'Alice Example' };
const bob = { id: 'u2', name: 'Bob Builder' };
const revision = (id: string, createdAt: number, reason: MockRevision['reason'], over: Partial<MockRevision> = {}): MockRevision => ({
  id,
  createdAt,
  title: 'Quarterly plan',
  reason,
  lastAuthor: alice,
  authors: [alice, bob],
  markdown: MARKDOWN.replace('Ship the history screens and the restore.', 'Ship the history screens.').replace('Paragraph 2 of the notes', 'The older wording of paragraph 2'),
  ...over,
});
export const HISTORY = {
  role: 'member' as 'member' | 'admin',
  current: MARKDOWN,
  revisions: [revision('r3', at(21, 16, 42), 'last_editor_left'), revision('r2', at(21, 11, 5), 'before_restore', { lastAuthor: bob, authors: [bob] }), revision('r1', at(20, 14, 30), 'idle', { lastAuthor: alice, authors: [alice] })],
};

const u = (id: string, name: string, role: MockUser['role'] = 'member', suspended = false): MockUser => ({ id, name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@dev.invalid`, role, suspended });
export const USERS = [u('u1', 'Alice Example', 'admin'), u('u2', 'Bob Builder'), u('u3', 'Carol Reader', 'viewer', true), u('u4', 'Dana Writer-Longsurname'), u('u5', 'Evangeline Montgomery-Fitzgerald')];

/** The tree of c1 with the page of the history stand-in three levels down, so that the breadcrumb and the palette have paths. */
async function tree(page: Page): Promise<void> {
  await page.route(`${API}/v1/collections/c1/tree`, (route) => {
    const request = route.request();
    const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': 'authorization, content-type, x-grimoire-client-version, idempotency-key' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ pages: PAGES }) });
  });
  await page.route(`${API}/v1/collections`, (route) => {
    const request = route.request();
    const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': 'authorization, content-type, x-grimoire-client-version, idempotency-key' };
    if (request.method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ items: COLLECTIONS }) });
  });
}

/** Overrides the collaboration address the client is told (the page screen with a live editor). */
export async function collabAt(page: Page, url: string): Promise<void> {
  await page.route(`${API}/v1/config`, (route) => {
    const request = route.request();
    const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': 'authorization, content-type, x-grimoire-client-version, idempotency-key' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ collabUrl: url, fileStoreOrigin: null, local: true, minClientVersion: '0.0.0', providerBaseUrl: null, providerProjectId: null }) });
  });
}

export interface Visit {
  readonly slug: string;
  readonly route: string;
  readonly path: string;
  readonly setup: (page: Page, context: BrowserContext) => Promise<void>;
  readonly ready: (page: Page) => Promise<void>;
}

const member = async (page: Page, context: BrowserContext, role: 'member' | 'admin' = 'member') => {
  await signInAs(context, 'e2e-alice', role, { check: false });
  await mockApi(page, { collections: [...COLLECTIONS], pages: [...PAGES], userName: 'Alice Example', role });
  await tree(page);
};
const history = async (page: Page, context: BrowserContext, role: 'member' | 'admin' = 'member') => {
  await signInAs(context, 'e2e-alice', role, { check: false });
  await historyApi(page, { ...HISTORY, role });
  await tree(page);
};
const admin = async (page: Page, context: BrowserContext) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, {
    role: 'admin',
    users: USERS.map((x) => ({ ...x })),
    groups: [{ id: 'g1', name: 'Platform team' }, { id: 'g2', name: 'Editors of the engineering handbook' }],
    members: { g1: ['u2', 'u3', 'u4', 'u5'], g2: ['u4'] },
    access: {
      defaultPermission: 'read',
      entries: [
        { id: 'e1', principalType: 'group', principalId: 'g1', permission: 'read_write' },
        { id: 'e2', principalType: 'user', principalId: 'u2', permission: 'read' },
        { id: 'e3', principalType: 'user', principalId: 'u5', permission: 'read_write' },
        { id: 'e4', principalType: 'group', principalId: 'g2', permission: 'read' },
      ],
    },
  });
};
const h1 = async (page: Page) => void (await page.getByRole('heading', { level: 1 }).first().waitFor());

const REPORT: readonly ScriptedItem[] = [
  { id: 'i1', path: 'handbook/welcome.md', status: 'ok' },
  { id: 'i2', path: 'handbook/guides/setting-up-your-development-environment-on-a-new-laptop.md', status: 'ok' },
  { id: 'i3', path: 'handbook/archive/everything.md', status: 'skipped', message: 'too_large' },
  { id: 'i4', path: 'handbook/notes/broken.md', status: 'failed', message: 'invalid-markdown', hasSource: true },
];

/** Every route of a11y/routes.ts STOPS, with the import screen in its three states. */
export const VISITS: readonly Visit[] = [
  { slug: 'login', route: '/login', path: '/login', setup: async (page) => void (await mockApi(page, { collections: [...COLLECTIONS], pages: [] })), ready: h1 },
  { slug: 'home', route: '/', path: '/', setup: (page, context) => member(page, context), ready: async (page) => { await page.waitForURL(/\/c\//); await h1(page); } },
  { slug: 'collections-new', route: '/collections/new', path: '/collections/new', setup: (page, context) => member(page, context, 'admin'), ready: async (page) => void (await page.getByRole('button', { name: 'Create collection' }).waitFor()) },
  { slug: 'collection', route: '/c/:collectionId', path: '/c/c1', setup: (page, context) => member(page, context), ready: async (page) => { await h1(page); await page.getByRole('link', { name: 'Dev' }).first().waitFor(); } },
  { slug: 'page', route: '/p/:slug', path: `/p/${SLUG}`, setup: (page, context) => history(page, context), ready: async (page) => void (await expect(page.getByTestId('editor-root')).toContainText('Deep heading')) },
  { slug: 'history', route: '/p/:slug/history', path: `/p/${SLUG}/history`, setup: (page, context) => history(page, context), ready: async (page) => void (await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(3)) },
  { slug: 'revision', route: '/p/:slug/history/:revisionId', path: `/p/${SLUG}/history/r3`, setup: (page, context) => history(page, context), ready: async (page) => void (await expect(page.getByTestId('revision-text').locator('.ProseMirror')).toContainText('older wording')) },
  {
    slug: 'search',
    route: '/search',
    path: '/search?q=paragraph',
    setup: async (page, context) => {
      await member(page, context);
      await scriptedSearch(page, () => ({
        items: [
          hit('r1', 'r1000000', 'Product roadmap', 'The paragraph for the next quarter: search first, then import, then files.', [[4, 13]], { matchedPassage: { text: 'Search comes before import because every later piece, the importer included, reads pages through it and checks what it finds.' } }),
          hit('r2', 'r2000000', 'Release checklist for the engineering handbook and runbooks collection', 'Before each release, check the paragraph and the open questions.', [[31, 40]]),
          hit('r3', 'r3000000', 'Handbook (all chapters)', 'The paragraph of the handbook is in the first chapter, with the owners.', [[4, 13]], { partial: true }),
        ],
      }));
    },
    ready: async (page) => void (await page.getByRole('link', { name: 'Product roadmap' }).waitFor()),
  },
  {
    slug: 'trash',
    route: '/trash',
    path: '/trash',
    setup: async (page, context) => {
      await signInAs(context, 'e2e-alice', 'member', { check: false });
      await mockApi(page, {
        collections: [...COLLECTIONS],
        pages: [...PAGES],
        userName: 'Alice Example',
        trash: [
          { item: { id: 'x1', title: 'Plan for May', collectionId: 'c1', deletedAt: Date.UTC(2026, 10, 20, 9, 0), deletedBy: null, daysLeft: 26 }, pages: [p('x1', null, 'p0009', 'Plan for May')] },
          { item: { id: 'x2', title: 'A page with a very long title that will not fit on one line of a phone', collectionId: 'c1', deletedAt: Date.UTC(2026, 10, 19, 9, 0), deletedBy: 'u2', daysLeft: 3 }, pages: [p('x2', null, 'p0010', 'A page with a very long title that will not fit on one line of a phone')] },
        ],
      });
      await tree(page);
    },
    ready: async (page) => void (await page.getByRole('button', { name: 'Restore Plan for May' }).waitFor()),
  },
  { slug: 'import-idle', route: '/import', path: '/import', setup: async (page, context) => { await member(page, context); await scriptedImports(page, []); }, ready: async (page) => void (await expect(page.getByLabel('Into the collection').getByRole('option')).toHaveCount(2)) },
  { slug: 'import-progress', route: '/import', path: '/import?import=imp1', setup: async (page, context) => { await member(page, context); await scriptedImports(page, [{ status: 'running', total: 25, done: 10 }]); }, ready: async (page) => void (await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')) },
  {
    slug: 'import-report',
    route: '/import',
    path: '/import?import=imp1',
    setup: async (page, context) => { await member(page, context); await scriptedImports(page, [{ status: 'done', total: 5, done: 3, skipped: 1, failed: 1, report: CONSTRUCT_REPORT }], { items: REPORT }); },
    ready: async (page) => void (await expect(page.getByRole('list', { name: 'Files of the import' }).getByRole('listitem')).toHaveCount(4)),
  },
  { slug: 'admin-users', route: '/admin/users', path: '/admin/users', setup: admin, ready: async (page) => void (await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(USERS.length)) },
  { slug: 'admin-groups', route: '/admin/groups', path: '/admin/groups?group=g1', setup: admin, ready: async (page) => void (await expect(page.getByRole('list', { name: 'Members' }).getByRole('listitem')).toHaveCount(4)) },
  { slug: 'admin-access', route: '/admin/collections/:id/access', path: '/admin/collections/c1/access', setup: admin, ready: async (page) => void (await page.getByRole('table', { name: 'Who has access' }).getByRole('row').nth(1).waitFor()) },
  { slug: 'help', route: '/help', path: '/help', setup: (page, context) => member(page, context), ready: h1 },
  { slug: 'not-found', route: '*', path: '/nowhere/at/all', setup: (page, context) => member(page, context), ready: h1 },
];

export async function open(page: Page, context: BrowserContext, visit: Visit): Promise<void> {
  await visit.setup(page, context);
  await page.goto(visit.path);
  await page.addStyleTag({ content: SANS });
  await visit.ready(page);
  // The person's name, where there is a session: the bar is settled.
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
}
