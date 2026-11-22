import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const serverPackage = JSON.parse(readFileSync('apps/server/package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('unused fake authentication is development-only (S11)', () => {
  it('the production dependency tree of the server does not include auth-fake (bun.lock)', () => {
    expect(serverPackage.dependencies?.['@tektum/grimoire-adapter-auth-fake']).toBeUndefined();
    expect(serverPackage.devDependencies?.['@tektum/grimoire-adapter-auth-fake']).toBe('*');
    // bun.lock is JSONC (trailing commas). Follow `dependencies` only, from the server workspace through every workspace package it needs.
    const lock = JSON.parse(readFileSync('bun.lock', 'utf8').replace(/,(\s*[}\]])/g, '$1')) as {
      workspaces: Record<string, { name: string; dependencies?: Record<string, string> }>;
    };
    const byName = new Map(Object.values(lock.workspaces).map((w) => [w.name, w]));
    const reached = new Set<string>();
    const walk = (name: string): void => {
      const workspace = byName.get(name);
      if (!workspace || reached.has(name)) return;
      reached.add(name);
      for (const dependency of Object.keys(workspace.dependencies ?? {})) walk(dependency);
    };
    walk('@tektum/grimoire-server');
    expect(reached).toContain('@tektum/grimoire-adapter-markdown-milkdown');
    expect(reached).not.toContain('@tektum/grimoire-adapter-auth-fake');
  });

  it('the production image copies no auth-fake directory or link', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');
    expect(dockerfile).toContain('packages/adapters/*');
    expect(dockerfile).toContain('rm -rf /out/packages/adapters/auth-fake /out/node_modules/@tektum/grimoire-adapter-auth-fake');
  });
});
