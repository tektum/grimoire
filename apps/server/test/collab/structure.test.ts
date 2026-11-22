import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { markdownPoolHook } from '../../src/composition.js';
import { SHUTDOWN_PHASES } from '../../src/lifecycle/shutdown.js';
import { DERIVED_BUDGETS_MS } from '../../src/lifecycle/budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => path.join(e.parentPath, e.name));

describe('structure', () => {
  it('createMarkdownConverter appears only in apps/server/src/composition.ts', () => {
    const hits = files(path.join(root, 'apps/server/src')).filter((f) => readFileSync(f, 'utf8').includes('createMarkdownConverter'));
    expect(hits.map((f) => path.relative(root, f))).toEqual(['apps/server/src/composition.ts']);
  });

  it('the core collaboration port names no Yjs type', () => {
    expect(readFileSync(path.join(root, 'packages/core/src/ports/collaboration-host.ts'), 'utf8')).not.toMatch(/yjs/);
  });

  it('the pool is closed by hook markdown-pool in phase release-jobs, after save-pages', () => {
    const converter = new FakeMarkdownConverter();
    const hook = markdownPoolHook(converter);
    expect(hook).toMatchObject({ name: 'markdown-pool', phase: 'release-jobs', deadlineMs: DERIVED_BUDGETS_MS.releaseJobs });
    expect(SHUTDOWN_PHASES.indexOf('release-jobs')).toBeGreaterThan(SHUTDOWN_PHASES.indexOf('save-pages'));
    void hook.run();
    expect(converter.closeRequested).toBe(true);
  });

  it('store_alarm appears only in files the collaboration host owns (events table, persistence extension, the throttle table comment); Markdown conversion added no second alarm path', () => {
    const hits = [...files(path.join(root, 'packages/adapters/collab-hocuspocus/src')), ...files(path.join(root, 'apps/server/src'))]
      .filter((f) => readFileSync(f, 'utf8').includes('store_alarm')).map((f) => path.relative(root, f)).sort();
    expect(hits).toEqual(['packages/adapters/collab-hocuspocus/src/events.ts', 'packages/adapters/collab-hocuspocus/src/extensions/persistence.ts', 'packages/adapters/collab-hocuspocus/src/log-throttle.ts']);
  });
});
