import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../../src/composition.js';
import type { AppContext } from '../../src/composition.js';
import { registerJobs } from '../../src/jobs/index.js';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { fakeJobDeps } from '../jobs/deps.js';

// M7-T11: the semantic search is built in the roles `api` and `all` when it is on, and in no other; the two embedding jobs are registered with it.
const base = {
  GRIMOIRE_DATABASE_URL: `postgresql://grimoire_app:${randomBytes(12).toString('hex')}@127.0.0.1:1/grimoire`,
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
  it.each(['api', 'all'])('role %s builds the embedder (it reports unavailable until the model is wired in) and closes it in release-jobs', async (role) => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: role });
    expect(ctx.semantic?.embedder.status()).toBe('unavailable');
    expect(ctx.semantic?.embedder.model).toMatchObject({ name: 'multilingual-e5-base', dims: 768 });
    const hook = ctx.shutdownHooks.find((h) => h.name === 'embedder');
    expect(hook?.phase).toBe('release-jobs');
    await hook?.run();
    expect(await ctx.semantic?.embedder.embedQuery('x')).toEqual({ ok: false, reason: 'unavailable' });
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
  const names = (embedder?: FakeEmbedder) => registerJobs(fakeJobDeps(embedder === undefined ? {} : { embedder }).deps).map((j) => j.name);

  it('registers embed-sweep and embed-page when there is an embedder, and neither when there is not', () => {
    expect(names(new FakeEmbedder())).toEqual(expect.arrayContaining(['embed-sweep', 'embed-page']));
    expect(names()).not.toEqual(expect.arrayContaining(['embed-sweep']));
    expect(names()).not.toEqual(expect.arrayContaining(['embed-page']));
  });

  it('the two entries have a handler that finishes (M7-T13 fills them) and no schedule yet', async () => {
    const jobs = registerJobs(fakeJobDeps({ embedder: new FakeEmbedder() }).deps).filter((j) => j.name.startsWith('embed-'));
    expect(jobs.map((j) => j.schedule)).toEqual([undefined, undefined]);
    const ctx = { jobId: 'j', attempt: 1, retryLimit: 3, signal: new AbortController().signal };
    for (const j of jobs) await expect(j.handler({ tenantId: 'T-a', pageId: 'p' }, ctx)).resolves.toBeUndefined();
  });
});

describe('the server and the adapter package', () => {
  it('depends on it, as it does on the other adapters (the composition is the only place that constructs one)', () => {
    const server = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(server.dependencies['@tektum/grimoire-adapter-embedder-onnx']).toBe('*');
  });
});
