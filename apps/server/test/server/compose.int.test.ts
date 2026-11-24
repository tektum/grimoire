import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, runToEnd } from '@tektum/grimoire-test-support';

/** What `docker compose config --format json` resolves a file set to: interpolation, merges and profiles all applied. */
interface Resolved {
  readonly services: Record<string, {
    readonly image?: string;
    readonly build?: unknown;
    readonly command?: readonly string[];
    readonly profiles?: readonly string[];
    readonly network_mode?: string;
    readonly networks?: Record<string, unknown> | null;
    readonly depends_on?: Record<string, unknown>;
    readonly environment?: Record<string, string | null>;
    readonly ports?: readonly { host_ip?: string; published?: string | number; target: number }[];
  }>;
  readonly networks?: Record<string, { readonly internal?: boolean; readonly external?: boolean | { name?: string } }>;
}

// `docker compose config` only renders the files: it needs the Compose plugin but no running engine. The renderer runs as a child of this
// process (through `runToEnd`), and only its standard output is the JSON (warnings go to standard error). Docker gets a minimal environment:
// Compose prefers the process environment over `--env-file` and over `${VAR:-default}`, so the harness's own variables (an allowed-origins
// value, a token secret) would hide what the committed files say.
const KEEP = ['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR'];
const RENDER = `const { spawnSync } = require('node:child_process'); const keep = ${JSON.stringify(KEEP)};`
  + " const env = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));"
  + " const r = spawnSync('docker', JSON.parse(process.argv[1]), { encoding: 'utf8', maxBuffer: 1 << 26, env });"
  + " process.stdout.write(r.status === 0 ? r.stdout : `docker compose failed: ${r.stderr}`); process.exitCode = r.status ?? 1;";

async function render(...files: string[]): Promise<Resolved> {
  const args = ['compose', '--project-directory', repoRoot, '--env-file', path.join(repoRoot, '.env.example'), '--profile', '*', ...files.flatMap((f) => ['-f', path.join(repoRoot, f)]), 'config', '--format', 'json'];
  // The child starts with the harness's own environment: forward what Docker needs to find its plugin (a custom config directory, the XDG paths).
  const forwarded = Object.fromEntries(KEEP.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] as string]])));
  const done = await runToEnd(['-e', RENDER, JSON.stringify(args)], forwarded);
  expect(done.code, done.output).toBe(0);
  return JSON.parse(done.output) as Resolved;
}

let local: Resolved;
let offline: Resolved;
// Two renders, each a child process that starts Docker's CLI: seconds on a loaded runner, so a 60 s bound for both.
beforeAll(async () => {
  local = await render('compose.yaml');
  offline = await render('compose.yaml', 'compose.offline.yaml');
}, 60_000);

const LOCAL_HOSTS = new Set(['postgres', 'seaweedfs', '127.0.0.1', 'localhost']);
const published = (s: Resolved['services'][string]) => (s.ports ?? []).map((p) => `${p.host_ip ?? ''}:${String(p.published)}->${String(p.target)}`);

describe('compose.yaml (R2.12, R13.1): the local stack', () => {
  it('has the application, PostgreSQL, the S3-compatible store and the migration service, and nothing else', () => {
    expect(Object.keys(local.services).sort()).toEqual(['app', 'migrate', 'postgres', 'seaweedfs']);
    expect(local.services['migrate']?.command).toContain('migrate');
    expect(local.services['migrate']?.profiles).toEqual(['tools']);
    expect(Object.keys(local.services['migrate']?.depends_on ?? {})).toEqual(['postgres']);
    expect(Object.keys(local.services['app']?.depends_on ?? {}).sort()).toEqual(['postgres', 'seaweedfs']);
  });

  it('runs PostgreSQL 17 with pgvector 0.8.5 pinned by digest, with the empty grimoire database on loopback port 55432', () => {
    const postgres = local.services['postgres'];
    expect(postgres?.image).toBe('pgvector/pgvector:0.8.5-pg17-bookworm@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0');
    expect(postgres?.environment?.['POSTGRES_DB']).toBe('grimoire');
    expect(published(postgres ?? {} as never)).toEqual(['127.0.0.1:55432->5432']);
  });

  it('runs SeaweedFS with its S3 gateway on port 8333, on loopback, pinned by digest', () => {
    const store = local.services['seaweedfs'];
    expect(store?.image).toMatch(/^[a-z0-9-]+\/seaweedfs:[0-9.]+@sha256:[0-9a-f]{64}$/);
    expect(store?.command).toContain('-s3');
    expect(published(store ?? {} as never)).toEqual(['127.0.0.1:8333->8333']);
  });

  it('builds the application from this repository and publishes it on loopback only', () => {
    const app = local.services['app'];
    expect(app?.build).toBeDefined();
    expect(app?.image).toBeUndefined();
    expect(published(app ?? {} as never)).toEqual(['127.0.0.1:8080->8080']);
  });
});

describe('compose.yaml (R1.7, R2.12, R2.14): nothing in the stack reaches outside it', () => {
  it('gives every URL anywhere in the resolved configuration (environment, commands, health checks) a host of the stack or loopback', () => {
    const hosts = new Set([...JSON.stringify(local).matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^\s"\\/@]*@)?([^\s"\\/:,]+)/gi)].map((m) => m[1] as string));
    expect(hosts.size).toBeGreaterThan(0);
    expect([...hosts].filter((h) => !LOCAL_HOSTS.has(h))).toEqual([]);
  });

  it('takes every image from Docker Hub by name (no cloud registry host), or builds it', () => {
    for (const [name, service] of Object.entries(local.services)) {
      if (service.image === undefined) {
        expect(service.build, `${name} has neither image nor build`).toBeDefined();
        continue;
      }
      const first = service.image.split('/')[0] as string;
      const registryHost = service.image.includes('/') && (first.includes('.') || first.includes(':'));
      expect(registryHost, `${name} uses a registry host: ${service.image}`).toBe(false);
    }
  });

  it('builds the application only from base images pinned by digest, so a build pulls exactly the reviewed bytes (a pull happens before the stack runs, not from it)', () => {
    const from = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8').split('\n').filter((l) => /^FROM\s/i.test(l));
    expect(from.length).toBeGreaterThan(0);
    for (const line of from) expect(line, line).toMatch(/^FROM\s+\S+@sha256:[0-9a-f]{64}(\s+AS\s+\S+)?\s*$/i);
  });

  it('points every endpoint, URL and origin of the application at the stack itself or at loopback', () => {
    const urls: string[] = [];
    for (const [key, value] of Object.entries(local.services['app']?.environment ?? {})) {
      if (value === null || value === '') continue;
      urls.push(...[...value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s,]+/gi)].map((m) => `${key}=${m[0]}`));
    }
    expect(urls.length).toBeGreaterThan(0);
    for (const entry of urls) {
      const host = new URL(entry.slice(entry.indexOf('=') + 1)).hostname;
      expect(LOCAL_HOSTS.has(host), `${entry} is not a local endpoint`).toBe(true);
    }
  });

  it('leaves every cloud identity setting empty: no Descope project, key or endpoint by default', () => {
    const env = local.services['app']?.environment ?? {};
    for (const key of ['GRIMOIRE_DESCOPE_PROJECT_ID', 'GRIMOIRE_DESCOPE_MANAGEMENT_KEY', 'GRIMOIRE_DESCOPE_BASE_URL', 'GRIMOIRE_S3_PUBLIC_ENDPOINT']) {
      expect(env[key], key).toBe('');
    }
  });
});

describe('compose.offline.yaml (R2.14): the no-route-out override', () => {
  it('makes the only network internal, and leaves the local one open', () => {
    expect(offline.networks?.['default']?.internal).toBe(true);
    expect(local.networks?.['default']?.internal).not.toBe(true);
  });

  it('leaves no service a way out: every one is on the default network alone, none on the host network, no network is external', () => {
    expect(Object.keys(offline.networks ?? {})).toEqual(['default']);
    expect(offline.networks?.['default']?.external).toBeUndefined();
    for (const [name, service] of Object.entries(offline.services)) {
      expect(service.network_mode, `${name} sets network_mode`).toBeUndefined();
      expect(Object.keys(service.networks ?? { default: null }), `${name} networks`).toEqual(['default']);
    }
  });

  it('changes nothing else: the same services with the same ports and environment', () => {
    expect(Object.keys(offline.services).sort()).toEqual(Object.keys(local.services).sort());
    for (const name of Object.keys(local.services)) {
      expect(offline.services[name]?.environment, name).toEqual(local.services[name]?.environment);
      expect(offline.services[name]?.image, name).toEqual(local.services[name]?.image);
      expect(published(offline.services[name] ?? {} as never), name).toEqual(published(local.services[name] ?? {} as never));
    }
  });
});
