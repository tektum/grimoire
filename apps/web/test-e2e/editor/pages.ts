import { randomUUID } from 'node:crypto';
import { buildDevToken } from '../../test/support/dev-token';
import { apiUrl, devSecret } from '../support/env';

export interface MadePage {
  readonly id: string;
  readonly urlId: string;
  readonly collectionId: string;
  /** The address of the page in the app. */
  readonly path: string;
}

async function call<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${buildDevToken(devSecret(), 'e2e-admin', 'admin')}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * A collection and a page in it with this Markdown, made through the API as an administrator. `permission` is the collection's default
 * for everyone else: `read_write` lets the e2e users edit, `read` makes them readers.
 */
export async function makePage(markdown: string, options: { title?: string; permission?: 'read' | 'read_write' } = {}): Promise<MadePage> {
  const collection = await call<{ id: string }>('POST', '/v1/collections', { name: `e2e ${randomUUID().slice(0, 8)}`, defaultPermission: options.permission ?? 'read_write' });
  const page = await call<{ id: string; urlId: string }>('POST', '/v1/pages', { collectionId: collection.id, markdown, title: options.title ?? 'Editor page' });
  return { id: page.id, urlId: page.urlId, collectionId: collection.id, path: `/p/page-${page.urlId}` };
}

/** Resets the saved state of a page as an administrator (`POST /v1/pages/{id}/reset-state`); every open editor of the page is closed with a stale epoch. */
export async function resetPageState(pageId: string, options: { confirmStale?: boolean; markdown?: string } = {}): Promise<void> {
  await call('POST', `/v1/pages/${pageId}/reset-state`, {
    ...(options.confirmStale === true ? { confirmStale: true } : {}),
    ...(options.markdown === undefined ? {} : { markdown: options.markdown }),
  });
}
