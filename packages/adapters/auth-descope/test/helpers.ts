import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, exportSPKI, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { Logger } from '@tektum/grimoire-core/ports/logger';

export const PID = 'P2testprojectidabcdefghijkl';
export type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

export async function makeKey(kid: string): Promise<{ pair: KeyPair; jwk: JWK }> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { pair, jwk };
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export function goodClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const t = nowSec();
  return { sub: 'U2user', iss: PID, drn: 'DS', iat: t, exp: t + 600, ...extra };
}

export async function sign(pair: KeyPair, kid: string, claims: Record<string, unknown> = goodClaims(), alg = 'RS256'): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg, kid, typ: 'JWT' }).sign(pair.privateKey);
}

export const b64 = (o: unknown): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export async function signHs256WithPublicKeyText(pair: KeyPair, kid: string): Promise<string> {
  const pem = await exportSPKI(pair.publicKey);
  return new SignJWT(goodClaims()).setProtectedHeader({ alg: 'HS256', kid }).sign(new TextEncoder().encode(pem));
}

export type Behaviour = 'ok' | 'hang' | { status: number; keys?: true } | { raw: string } | { chunked: string } | { stalledAfterHeaders: number } | 'huge';

/** A local key-set server on 127.0.0.1 that counts requests. */
export class KeyServer {
  requests = 0;
  paths: string[] = [];
  behaviour: Behaviour = 'ok';
  keys: JWK[] = [];
  private server: Server | undefined;
  private port = 0;

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(this.port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (s === undefined) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    this.requests += 1;
    this.paths.push(req.url ?? '');
    const b = this.behaviour;
    if (b === 'hang') return;
    if (b === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: this.keys })); return; }
    if (b === 'huge') { res.writeHead(200, { 'content-type': 'application/json' }).end(`{"keys":[],"pad":"${'x'.repeat(5_000_000)}"}`); return; }
    if ('status' in b) { res.writeHead(b.status, b.keys === true ? { 'content-type': 'application/json' } : {}).end(b.keys === true ? JSON.stringify({ keys: this.keys }) : 'nope'); return; }
    if ('stalledAfterHeaders' in b) {
      // Declares a body of this many bytes and never sends one: only a reader that trusts the declaration can answer before the timeout.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(b.stalledAfterHeaders) });
      res.flushHeaders();
      return;
    }
    if ('chunked' in b) {
      // No Content-Length: the first write sends the headers, so the body is streamed and its size is not declared.
      res.writeHead(200, { 'content-type': 'application/json' });
      const half = Math.floor(b.chunked.length / 2);
      res.write(b.chunked.slice(0, half));
      res.end(b.chunked.slice(half));
      return;
    }
    // an explicit Content-Length: the size is declared before the body
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(b.raw)) }).end(b.raw);
  }
}

export interface Captured { level: string; event: string; fields: Record<string, unknown> | undefined }
export function captureLogger(): { logger: Logger; lines: Captured[] } {
  const lines: Captured[] = [];
  const make = (): Logger => {
    const rec = (level: string) => (event: string, fields?: Record<string, unknown>): void => { lines.push({ level, event, fields }); };
    return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => make() };
  };
  return { logger: make(), lines };
}
