import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWK } from 'jose';

// A minimal stand-in for Descope's key service and token issuer, for the server's tests. The adapter's own helpers live in its test
// folder and cannot be shared without giving the shared test-support package a `jose` dependency (a package change); this is the
// smallest double the server needs: one signing key, a key-set endpoint that can be switched down, and session/refresh tokens.

/** A project id of the real shape (28 characters, region-free): the key URL is `<base>/v2/keys/<id>`. */
export const PROJECT_ID = 'P2servertestprojectabcdefghi';
export const KID = 'k-server-test';

export interface Issuer {
  readonly jwks: { keys: JWK[] };
  /** A session token (`drn: DS`) for `sub`; `claims` override any field (exp, iss, drn, ...); seconds are epoch seconds. */
  token(sub: string, claims?: Record<string, unknown>): Promise<string>;
}

export async function createIssuer(projectId = PROJECT_ID): Promise<Issuer> {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  return {
    jwks: { keys: [jwk] },
    token(sub, claims = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ sub, iss: projectId, drn: 'DS', iat: now, exp: now + 600, ...claims }).setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' }).sign(pair.privateKey);
    },
  };
}

/** The key-set service on 127.0.0.1: `down` answers 503 (an outage); `requests` counts calls. */
export class KeyService {
  requests = 0;
  down = false;
  private server: Server | undefined;
  private port = 0;
  constructor(private readonly issuer: Issuer, private readonly projectId = PROJECT_ID) {}

  get baseUrl(): string { return `http://127.0.0.1:${String(this.port)}`; }

  async start(): Promise<void> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.requests += 1;
      if (this.down) { res.writeHead(503).end(); return; }
      if (req.url !== `/v2/keys/${this.projectId}`) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.issuer.jwks));
    });
    this.server = server;
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (s === undefined) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => { s.close(() => { resolve(); }); });
  }
}
