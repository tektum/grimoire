import type { Page, Route } from '@playwright/test';
import { fixtureServer } from '../support/fixtures';
import { bundleHarness } from '../collections/bundle';

const API = 'http://127.0.0.1:8080';
export interface Sent {
  readonly confirmStale?: boolean;
  readonly markdown?: string;
}

/**
 * Opens the reset dialog on a page of its own server and answers its calls from `answers`, one per call, in order. The requests, as the server would see them, are
 * in `sent`. `stop()` stops the server.
 */
export async function openReset(page: Page, answers: readonly { status: number; body: unknown }[], sans = false) {
  const bundle = await bundleHarness('../admin/reset-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><html lang="en"><meta charset="utf-8"><title>Grimoire</title><div id="host"></div></html>' });
  const sent: Sent[] = [];
  await page.route(`${API}/v1/pages/*/reset-state`, (route: Route) => {
    const request = route.request();
    const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    sent.push(JSON.parse(request.postData() ?? '{}') as Sent);
    const answer = answers[sent.length - 1] ?? { status: 500, body: { error: { code: 'x', message: 'unexpected call' } } };
    return route.fulfill({ status: answer.status, contentType: 'application/json', headers: cors, body: JSON.stringify(answer.body) });
  });
  await page.goto(server.url('/'));
  await page.addStyleTag({ content: bundle.css });
  if (sans) await page.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" });
  await page.addScriptTag({ content: bundle.js });
  await page.evaluate(() => { (window as unknown as { show: () => void }).show(); });
  return { sent, stop: () => server.stop() };
}
