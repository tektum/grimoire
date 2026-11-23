# 11. Frameworks and portability

Research date 2026-11-19. Facts carry URLs. Recommendations are labelled **Rec**. Versions come from package registry metadata (https://registry.npmjs.org/<pkg>); "modified" is the registry's `time.modified`, not necessarily the last release.

## Summary
1. **Rec:** Hono (API) + OpenAPI contract + generated typed client; React + Vite single-page app; Milkdown; Descope's web SDKs.
2. **Rec:** Drizzle or Kysely on PostgreSQL; S3 API for files (MinIO local); pg-boss in containers behind a small job port.
3. **Rec:** Hocuspocus 4 for live editing in a container; no full batteries-included framework or platform.
4. Wrap the same SPA with Tauri 2 (or Electron) for desktop and Capacitor/Tauri for mobile; sign-in in wrappers is the main unknown.
5. Main trade-off: HTTP, database, storage, auth and jobs port cleanly to three hosts. Live editing does not; it needs a separate implementation per host.
6. Batteries-included platforms (Supabase, Convex, Jazz and others) replace much code but would replace the Yjs/Postgres design and the hosting freedom.

## 1. Backend framework
| | Runtimes (how) | Included | Licence / version / modified |
|---|---|---|---|
| Hono | Workers, Deno, Bun, Lambda, Node, one codebase ([README](https://raw.githubusercontent.com/honojs/hono/main/README.md)); Node via `@hono/node-server` | Routing, middleware; validation, OpenAPI (`@hono/zod-openapi`) and RPC client are add-ons ([RPC](https://hono.dev/docs/guides/rpc)); WS via per-runtime helpers (`@hono/node-ws`) | MIT / 4.13.19 / 2026-11-16 |
| Fastify | Node; Lambda via `@fastify/aws-lambda` ([README](https://raw.githubusercontent.com/fastify/aws-lambda-fastify/master/README.md)); Workers not confirmed | Routing, schema validation, plugins; OpenAPI and WS via plugins | MIT / 5.12.8 / 2026-11-02 |
| NestJS | Node; has serverless guide and a Cloudflare Workers HTTP adapter page ([docs](https://docs.nestjs.com/faq/serverless)); Workers maturity not confirmed | DI, modules, guards, WS gateways, OpenAPI module, queues; ORM via integrations | MIT / 12.5.1 / 2026-11-18 |
| AdonisJS | Node only ("Fullstack MVC framework for Node.js", [README](https://raw.githubusercontent.com/adonisjs/core/main/README.md)) | Largest built-in set (ORM, auth, validation) | MIT / 7.7.0 / 2026-11-19 |
| Elysia | Bun first; has Node, Cloudflare Worker, Deno integration pages ([Workers](https://elysiajs.com/integrations/cloudflare-worker.html), [Node](https://elysiajs.com/integrations/node.html)) | Routing, validation, OpenAPI plugin, typed client (Eden) | MIT / 1.4.32 / 2026-11-11 |
| h3 | Not checked in detail | Minimal | MIT / 2.0.8 / 2026-10-22 |

**Answer:** Only AdonisJS and NestJS are truly batteries-included, and both lean on Node and DI/ORM conventions, which fight hosting freedom (AdonisJS is Node only). Hono is the only one whose own README promises the same code on Node, Lambda and Workers. **Rec:** Hono; its "batteries" are small add-ons you choose, which suits (c) and (e).

## 2. Typed API contract
| Option | Fact | Non-TS client later? |
|---|---|---|
| OpenAPI-first + generated client | `openapi-typescript` 7.13.0 MIT, `@hey-api/openapi-ts` 0.99.0 MIT; `@hono/zod-openapi` 1.6.3 MIT emits the spec | Yes, any language |
| Hono RPC | Types inferred from routes, TS only ([docs](https://hono.dev/docs/guides/rpc)) | No |
| tRPC | 11.29.5 MIT | No (TS procedures) |
| oRPC | 1.16.4 MIT; OpenAPI support claimed, see [comparison](https://orpc.dev/docs/comparison) | Partly, via OpenAPI |
| ts-rest | 3.52.1 MIT, last modified 2025-06-02 (stale) | Partly |

**Rec:** Hono + zod-openapi, publish `openapi.json`, generate the TS client with openapi-typescript. Costs one build step; keeps Swift/Kotlin clients open.

## 3. Collaboration server portability
| Option | Runtimes | Version / licence |
|---|---|---|
| Hocuspocus 4 | Docs: "Runs on Node.js, Bun, Deno, and Cloudflare Workers (since v4)" ([docs](https://tiptap.dev/docs/hocuspocus/introduction)); built on `crossws` ([package](https://www.npmjs.com/package/@hocuspocus/server)); changelog mentions "cross-ws (bun, deno, cloudflare…)" ([CHANGELOG](https://raw.githubusercontent.com/ueberdosis/hocuspocus/main/CHANGELOG.md)) | 4.8.0 MIT, 2026-10-28 |
| y-websocket server | In-memory Node server; README says it "can't be scaled easily" ([README](https://raw.githubusercontent.com/yjs/y-websocket/master/README.md)) | 3.1.0 MIT |
| y-partyserver / PartyServer | `YServer` extends Cloudflare `DurableObject` ([README](https://raw.githubusercontent.com/cloudflare/partykit/main/packages/y-partyserver/README.md)); Workers only | 2.2.0 ISC |
| y-durableobjects | Workers + Durable Objects, requires Hono 4.3+ ([README](https://raw.githubusercontent.com/napolab/y-durableobjects/main/README.md)) | 1.0.5 MIT, 2025-08-05 |
| y-sweet | Rust server, MIT ([README](https://raw.githubusercontent.com/jamsocket/y-sweet/main/README.md)); SDK 0.9.1, 2025-09-16 | MIT |
| AWS Lambda | No maintained Yjs server found. Lambda cannot hold a long-lived socket; API Gateway WebSocket exists ([docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html)) | n/a |

**Honest answer:** "One clean interface, three hosting flavours" is **not realistic** for live editing. Lambda has no maintained option. Workers needs Durable Objects to hold a room's state and sockets; whether Hocuspocus 4 on Workers uses Durable Objects, and whether a Hocuspocus codebase can be shared with a Node container unchanged, is **not confirmed** (docs claim Workers support, no details fetched). Realistic design: **a shared client-facing protocol (Yjs sync over WebSocket) with a separate implementation per host**: container = Hocuspocus; Workers = y-partyserver/y-durableobjects (or Hocuspocus if it proves out); Lambda = the retired custom relay with its own wire protocol, which would need a thin client-side provider switch or a protocol shim. **Rec:** build only the container flavour now; keep the provider and persistence calls behind one port.

## 4. Data layer
| Tool | Node / Lambda / Workers | Notes |
|---|---|---|
| Drizzle | Many drivers incl. Cloudflare ([connect docs](https://orm.drizzle.team/docs/connect-overview)); 0.45.4 Apache-2.0 | SQL-like, migrations kit |
| Kysely | "Deno, Bun, Cloudflare Workers" ([README](https://raw.githubusercontent.com/kysely-org/kysely/master/README.md)); 0.29.9 MIT | Query builder; migrator included |
| Prisma | Workers guide for v7 ([docs](https://www.prisma.io/docs/orm/prisma-client/deployment/edge/deploy-to-cloudflare)); CLI 8.0.0-rc.34 Apache-2.0 (pre-release) | Heavier |
| Postgres drivers | `pg` via Hyperdrive ([docs](https://developers.cloudflare.com/hyperdrive/get-started/)); `@neondatabase/serverless` 1.2.1 MIT; `postgres` 4.1.1 is **Unlicense** (flag) | |

Workers reaches PostgreSQL through Hyperdrive (pooling) with a driver such as `pg`; Lambda needs a pooler (RDS Proxy or similar, not confirmed). **Rec:** stay PostgreSQL-only; do not abstract beyond it (Yjs state, search and relational data are Postgres-shaped). Files: R2 documents an S3 API and presigned URLs ([docs](https://developers.cloudflare.com/r2/api/s3/api/)); MinIO local compatibility and R2 feature gaps are not confirmed. **Rec:** S3 API with presigned URLs is a sufficient port.

## 5. Platforms
| Platform | Would replace | Licence | Self-host | Conflict |
|---|---|---|---|---|
| Supabase | Postgres, auth, storage, realtime | MIT/Apache mix ([README](https://raw.githubusercontent.com/supabase/supabase/master/README.md)) | Yes | Replaces Descope; many moving parts (e) |
| PocketBase | API, auth, files (SQLite) | MIT ([README](https://raw.githubusercontent.com/pocketbase/pocketbase/master/README.md)) | Yes | SQLite not Postgres; Go binary, no Lambda/Workers (c) |
| Convex | DB, functions, realtime | Apache-2.0 (npm); backend self-hostable ([README](https://raw.githubusercontent.com/get-convex/convex-backend/main/README.md)) | Yes | Own database, no Postgres (c) |
| Appwrite | Auth, DB, storage | BSD-3 (SDK); server licence not confirmed | Not confirmed | Not confirmed |
| Liveblocks | Collaboration hosting | Client Apache-2.0; server not confirmed | Not confirmed | Hosted dependency |
| Jazz | Sync + local-first data | MIT (2.0.0-alpha) | Not confirmed | Alpha, replaces Yjs model |
| Zero | Sync engine for Postgres | Apache-2.0 | Not confirmed | Query-sync, not rich-text CRDT |
| Electric | Postgres sync | Apache-2.0 | Not confirmed | Reads only; not docs collaboration |
| y-sweet | Yjs server | MIT | Yes | Container only |

None clearly fits. No recommendation.

## 6. Client
Milkdown publishes `@milkdown/react` 7.23.0 MIT (also supports other frameworks, [docs](https://milkdown.dev/docs/guide/using-frameworks)); Descope publishes `@descope/react-sdk` 3.5.7 MIT, `@descope/web-js-sdk` 1.54.7, `@descope/react-native-sdk` 0.13.1, plus Flutter ([docs](https://docs.descope.com/getting-started/flutter)). **Rec:** React + Vite SPA.

| Wrapper | Platforms | Licence / version | Webview |
|---|---|---|---|
| Electron | Win, macOS, Linux ([support](https://www.electronjs.org/docs/latest/tutorial/support)); no mobile | MIT 45.4.1 | Bundled Chromium: same engine everywhere, best for ProseMirror/IME |
| Tauri 2 | Win, macOS, Linux, iOS, Android ([site](https://v2.tauri.app/start/)) | Apache-2.0 OR MIT, API 2.12.5 | System webview: WebView2, WebKit (macOS, iOS, Linux), Android WebView ([docs](https://v2.tauri.app/reference/webview-versions/)); engine varies per OS |
| Capacitor | iOS, Android; web/PWA ([docs](https://capacitorjs.com/docs)) | MIT 8.6.2 | System webviews |

ProseMirror/IME behaviour in these webviews: not confirmed from primary sources. IndexedDB offline storage: expected in every webview but not confirmed here. Descope has a page on "Unsupported WebView for OAuth" ([docs](https://docs.descope.com/auth-methods/oauth/customize/unsupported-webview-oauth)); a documented desktop/Tauri/Capacitor sign-in flow is not confirmed. **Rec:** prototype sign-in in the chosen wrapper before committing.

## 7. Background work
| Option | Fit |
|---|---|
| pg-boss 12.38.2 MIT | Postgres-backed queue, no Redis; in-process worker in container |
| graphile-worker 0.18.0 MIT | Same idea, Postgres |
| Plain in-process runner | Simplest; port `enqueue(name, payload)` |

**Rec:** define `JobQueue.enqueue`; container uses pg-boss or an in-process runner; Lambda maps to SQS, Workers to Cloudflare Queues (not verified here).

## Proposed interfaces (Rec)
| Port | Container | Lambda | Workers |
|---|---|---|---|
| HTTP runtime (Hono app) | `@hono/node-server`: easy | Hono Lambda adapter: easy | Native: easy |
| Database | Drizzle/Kysely + `pg`: easy | Same + pooler: moderate | Hyperdrive + `pg`: moderate |
| File storage (S3 API) | MinIO/S3: easy | S3: easy | R2 S3 API: easy |
| Auth verifier (Descope JWT) | `@descope/node-sdk`: easy | Same: easy | Workers compatibility not confirmed: moderate |
| Job queue | pg-boss or in-process: easy | SQS: moderate | Queues: moderate |
| Collaboration host | Hocuspocus: easy | Relay prototype: separate implementation | Durable Objects: separate implementation |

## Not confirmed
- Whether Hocuspocus 4 on Workers needs Durable Objects, and whether the code is shared with Node.
- Workers compatibility of `@descope/node-sdk`; Descope sign-in inside Tauri, Electron, Capacitor.
- ProseMirror/IME behaviour in each webview; IndexedDB specifics.
- Fastify on Workers; NestJS-on-Workers maturity; Lambda database pooling.
- Self-hosting and server licences for Appwrite, Liveblocks, Jazz, Zero, Electric.
- MinIO/R2 S3 feature gaps; Cloudflare Queues and SQS mappings.
- True last-publish dates. GitHub pushes (https://api.github.com/repos/honojs/hono, /ueberdosis/hocuspocus, /jamsocket/y-sweet, /napolab/y-durableobjects): Hono 2026-11-19 (32,995 stars), Hocuspocus 2026-11-19 (2,662), y-sweet 2025-12-04 (repo licence shown as NOASSERTION), y-durableobjects 2026-08-14.
