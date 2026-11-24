import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`: a real origin, so the page is a normal page (a page that a test fulfils by interception cannot open a WebSocket or fetch from loopback). */
  readonly origin: string;
  url(pathname: string): string;
  stop(): Promise<void>;
}

/** Serves small HTML fixtures from memory, one per path, on a free loopback port. */
export async function fixtureServer(pages: Readonly<Record<string, string>>): Promise<FixtureServer> {
  const server = http.createServer((req, res) => {
    const body = pages[new URL(req.url ?? '/', 'http://x').pathname];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, url: (pathname) => `${origin}${pathname}`, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
