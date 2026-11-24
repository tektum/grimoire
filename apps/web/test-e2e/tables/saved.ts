import { expect } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { apiUrl, devSecret } from '../support/env';

/** The page's saved Markdown, as the server has it (`GET /v1/pages/{id}/markdown`, read as an administrator). */
export async function savedMarkdown(pageId: string): Promise<string> {
  const response = await fetch(`${apiUrl()}/v1/pages/${pageId}/markdown`, { headers: { Authorization: `Bearer ${buildDevToken(devSecret(), 'e2e-admin', 'admin')}` } });
  if (!response.ok) throw new Error(`GET markdown answered ${String(response.status)}`);
  return response.text();
}

/** Waits until the saved Markdown contains `wanted` (the server saves a few seconds after an edit): polls, never a fixed sleep. */
export async function expectSaved(pageId: string, wanted: string): Promise<void> {
  await expect.poll(() => savedMarkdown(pageId), { timeout: 20_000, message: `the saved Markdown contains ${JSON.stringify(wanted)}` }).toContain(wanted);
}
