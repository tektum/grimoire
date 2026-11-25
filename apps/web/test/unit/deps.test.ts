// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

/** The web client's packages, exact (contracts section 1). A change here is a change of the contract. */
const PINS: Readonly<Record<string, string>> = {
  react: '19.3.1',
  'react-dom': '19.3.1',
  'react-router': '8.5.2',
  '@tanstack/react-query': '5.108.1',
  zustand: '5.1.0',
  '@radix-ui/react-dialog': '1.3.1',
  '@radix-ui/react-dropdown-menu': '2.2.1',
  '@radix-ui/react-popover': '1.3.1',
  '@radix-ui/react-tooltip': '1.4.1',
  '@radix-ui/react-select': '2.4.1',
  '@radix-ui/react-tabs': '1.2.1',
  '@radix-ui/react-alert-dialog': '1.2.1',
  '@radix-ui/react-visually-hidden': '1.2.13',
  cmdk: '1.1.1',
  sonner: '2.0.8',
  'react-arborist': '4.0.1',
  'react-dnd-html5-backend': '16.0.1', // declared because the drag-image replacement imports it (src/vendor), not left to react-arborist's peer
  'lucide-react': '1.77.0',
  diff: '9.0.0',
  dompurify: '3.5.0',
  '@milkdown/core': '7.23.0',
  '@milkdown/ctx': '7.23.0',
  '@milkdown/prose': '7.23.0',
  '@milkdown/utils': '7.23.0',
  '@milkdown/preset-commonmark': '7.23.0',
  '@milkdown/preset-gfm': '7.23.0',
  '@milkdown/plugin-collab': '7.23.0',
  '@milkdown/plugin-listener': '7.23.0',
  '@milkdown/plugin-clipboard': '7.23.0',
  '@milkdown/plugin-cursor': '7.23.0',
  '@milkdown/plugin-trailing': '7.23.0',
  '@milkdown/plugin-slash': '7.23.0',
  '@milkdown/plugin-tooltip': '7.23.0',
  '@milkdown/plugin-block': '7.23.0',
  '@milkdown/plugin-upload': '7.23.0',
  '@hocuspocus/provider': '4.8.0',
  yjs: '13.6.33',
  'y-prosemirror': '1.3.7',
  '@descope/web-component': '4.7.5',
  '@descope/web-js-sdk': '1.54.7',
  vite: '8.3.8',
  '@vitejs/plugin-react': '6.3.0',
  tailwindcss: '4.3.5',
  '@tailwindcss/vite': '4.3.5',
  '@axe-core/playwright': '4.14.0',
  'axe-core': '4.14.0',
  '@testing-library/react': '16.3.3',
  '@testing-library/dom': '10.4.2',
  '@testing-library/user-event': '14.6.13',
  'happy-dom': '21.0.4',
  sirv: '3.0.2',
};
/** Pinned for the type checker, which the contract does not list: types for the two React packages. */
const TYPE_PINS: Readonly<Record<string, string>> = { '@types/react': '19.3.0', '@types/react-dom': '19.3.0' };
/** Chosen against in the contract, each with its reason there. */
const NOT_USED = ['openapi-react-query', '@milkdown/kit', '@milkdown/crepe', '@milkdown/plugin-history', 'y-indexeddb', '@tanstack/react-router', 'wouter'];

const manifest = JSON.parse(readFileSync(path.join(root, 'apps/web/package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const declared: Record<string, string> = { ...manifest.dependencies, ...manifest.devDependencies };

/** `name@version` of every package `bun pm ls --all` shows, as name -> versions. */
function installed(): Map<string, Set<string>> {
  const out = execFileSync('bun', ['pm', 'ls', '--all'], { cwd: root, encoding: 'utf8' });
  const found = new Map<string, Set<string>>();
  for (const match of out.matchAll(/(@?[\w./-]+?)@(\d[\w.+-]*)(?=\s|$)/gm)) {
    const [, name, version] = match as unknown as [string, string, string];
    found.set(name, (found.get(name) ?? new Set()).add(version));
  }
  return found;
}

describe('the web client dependencies', () => {
  it('declares every package of the contract at its exact version, and nothing else outside the workspace and the type packages', () => {
    const external = Object.fromEntries(Object.entries(declared).filter(([, v]) => v !== '*'));
    expect(external).toEqual({ ...PINS, ...TYPE_PINS });
  });

  it('declares the shared workspace packages the client uses', () => {
    const workspace = Object.keys(declared)
      .filter((name) => declared[name] === '*')
      .sort();
    expect(workspace).toEqual(['@tektum/grimoire-api-client', '@tektum/grimoire-core', '@tektum/grimoire-editor-schema']);
  });

  it('has each pinned package installed at that version, and none of the packages the contract rejects', () => {
    const found = installed();
    for (const [name, version] of Object.entries({ ...PINS, ...TYPE_PINS })) expect([name, [...(found.get(name) ?? [])].includes(version)]).toEqual([name, true]);
    for (const name of NOT_USED) expect([name, found.has(name)]).toEqual([name, false]);
  });

  it("has the identity provider's libraries pull in the one fingerprinting package the licence exception names, at exactly its version", () => {
    expect([...(installed().get('@fingerprintjs/fingerprintjs-pro') ?? [])]).toEqual(['3.11.6']);
  });
});
