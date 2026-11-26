import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose } from '../../src/composition.js';
import type { AppContext } from '../../src/composition.js';
import { registerJobs } from '../../src/jobs/index.js';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';
import { FakeEmbeddingStore } from '@tektum/grimoire-core/testing/fake-embedding-store';
import { fakeJobDeps } from '../jobs/deps.js';

// M7-T11: the semantic search is built in the roles `api` and `all` when it is on, and in no other; the two embedding jobs are registered with it.
const base = {
  GRIMOIRE_DATABASE_URL: `postgresql://grimoire_app:${randomBytes(12).toString('hex')}@127.0.0.1:1/grimoire`,
  GRIMOIRE_DATABASE_OPS_URL: placeholderDatabaseUrl('127.0.0.1:1'),
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
  GRIMOIRE_DEV_TOKEN_SECRET: randomBytes(24).toString('hex'),
  GRIMOIRE_LOCAL: '1',
};
const opened: AppContext[] = [];
afterEach(async () => { for (const c of opened.splice(0)) for (const h of c.shutdownHooks) await h.run(); });
function ctxOf(extra: Record<string, string> = {}): AppContext {
  const c = compose({ ...base, ...extra });
  if (!c.ok) throw new Error(c.issues.join('; '));
  opened.push(c.ctx);
  return c.ctx;
}

describe('the composition and the semantic search', () => {
  it.each(['api', 'all'])('role %s builds the embedder (it starts loading, and with no model in the folder it reports unavailable) and closes it in release-jobs', async (role) => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: role, GRIMOIRE_SEMANTIC_MODEL_DIR: resolve(import.meta.dirname, 'no-such-models') });
    await vi.waitFor(() => { expect(ctx.semantic?.embedder.status()).toBe('unavailable'); }, { timeout: 10_000, interval: 50 });
    expect(ctx.semantic?.embedder.model).toMatchObject({ name: 'multilingual-e5-base', dims: 768 });
    const hook = ctx.shutdownHooks.find((h) => h.name === 'embedder');
    expect(hook?.phase).toBe('release-jobs');
    await hook?.run();
    expect(await ctx.semantic?.embedder.embedQuery('x')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('gives the search route the hybrid search when it is on: the same embedder and store as the jobs, with the settings of the configuration; none when it is off', () => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: 'api', GRIMOIRE_SEMANTIC_MODEL_DIR: resolve(import.meta.dirname, 'no-such-models') });
    expect(ctx.http.hybrid?.embedder).toBe(ctx.semantic?.embedder);
    expect(ctx.http.hybrid?.store).toBe(ctx.semantic?.store);
    expect(ctx.http.hybrid?.settings).toMatchObject({ enabled: true, queryTimeoutMs: ctx.config.semantic.queryTimeoutMs, minSimilarity: ctx.config.semantic.minSimilarity, candidates: ctx.config.semantic.candidates });
    expect(ctxOf({ GRIMOIRE_SEMANTIC_SEARCH: 'off' }).http.hybrid).toBeUndefined();
  });

  it('role collab builds nothing of it', () => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: 'collab', GRIMOIRE_COLLAB_PORT: '8081' });
    expect(ctx.semantic).toBeUndefined();
    expect(ctx.shutdownHooks.some((h) => h.name === 'embedder')).toBe(false);
  });

  it('GRIMOIRE_SEMANTIC_SEARCH=off builds nothing of it in any role, and takes the model from its setting when on', () => {
    expect(ctxOf({ GRIMOIRE_SEMANTIC_SEARCH: 'off' }).semantic).toBeUndefined();
    const small = ctxOf({ GRIMOIRE_SEMANTIC_MODEL: 'multilingual-e5-small' });
    expect(small.semantic?.embedder.model).toMatchObject({ name: 'multilingual-e5-small', dims: 384 });
  });
});

describe('the registry and the embedding jobs', () => {
  const names = (embedder?: FakeEmbedder) => registerJobs(fakeJobDeps(embedder === undefined ? {} : { embedder, embeddings: new FakeEmbeddingStore() }).deps).map((j) => j.name);

  it('registers embed-sweep and embed-page when there is an embedder, and neither when there is not', () => {
    expect(names(new FakeEmbedder())).toEqual(expect.arrayContaining(['embed-sweep', 'embed-page']));
    expect(names()).not.toEqual(expect.arrayContaining(['embed-sweep']));
    expect(names()).not.toEqual(expect.arrayContaining(['embed-page']));
  });

  it('the two entries have no cron schedule (the sweep sends its own next run)', () => {
    const jobs = registerJobs(fakeJobDeps({ embedder: new FakeEmbedder(), embeddings: new FakeEmbeddingStore() }).deps).filter((j) => j.name.startsWith('embed-'));
    expect(jobs.map((j) => j.schedule)).toEqual([undefined, undefined]);
  });
});

describe('the server and the adapter package', () => {
  it('depends on it, as it does on the other adapters (the composition is the only place that constructs one)', () => {
    const server = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(server.dependencies['@tektum/grimoire-adapter-embedder-onnx']).toBe('*');
  });
});

describe('the rate cap of the registered embed-page job', () => {
  it('is measured in real time whatever clock the registry was given: a frozen clock does not hold a page back for ever', async () => {
    const embeddings = new FakeEmbeddingStore();
    const page = '11111111-1111-4111-8111-111111111111';
    embeddings.seedPage({ id: page, collectionId: 'c', markdownHash: new Uint8Array(32).fill(1), text: Array.from({ length: 5 }, (_, p) => Array.from({ length: 120 }, (_, k) => `p${String(p)}w${String(k)}`).join(' ')).join('\n\n') });
    const embedder = new FakeEmbedder({ maxTokens: 512 });
    const { deps } = fakeJobDeps({ embedder, embeddings }); // the fake clock of fakeJobDeps never advances
    const job = registerJobs(deps).find((j) => j.name === 'embed-page');
    const ctx = { jobId: 'j', attempt: 1, retryLimit: 3, signal: new AbortController().signal };
    const began = Date.now();
    await job?.handler({ tenantId: 'legacy', pageId: page }, ctx);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(embeddings.stored(page, 'fake-e5-v1').chunks.length).toBeGreaterThanOrEqual(3);
  }, 10_000);
});

