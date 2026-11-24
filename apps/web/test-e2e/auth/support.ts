import type { Page, Request } from '@playwright/test';
import { apiUrl } from '../support/env';

/** The settings of the page: where the API is, from `E2E_API_URL`, whatever the built `config.json` says. */
export async function pointAtApi(page: Page): Promise<void> {
  await page.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apiUrl: apiUrl() }) }));
}

/** Every request the page makes, with its headers read in full (a cookie would show here). */
export function recordRequests(page: Page): { all: () => Request[]; urls: () => string[] } {
  const seen: Request[] = [];
  page.on('request', (request) => seen.push(request));
  return { all: () => seen, urls: () => seen.map((r) => r.url()) };
}

/** The hosts the sign-in screen's third-party scripts come from (the provider's own hosts are covered by `isRemote`: nothing outside the machine is reached). */
export const PROVIDER_HOSTS = ['fpnpmcdn.net', 'descopecdn.com'] as const;

const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
/** Whether a URL leaves the machine: any host that is not loopback. The app's own document and the API of the stack are on loopback. */
export const isRemoteUrl = (url: string): boolean => URL.canParse(url) && !LOCAL_HOSTS.includes(new URL(url).hostname);

/** Whether a URL is on one of `hosts` (the host itself or a subdomain), read through the URL parser, not as a substring. */
export function onHost(url: string, hosts: readonly string[]): boolean {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname;
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}
