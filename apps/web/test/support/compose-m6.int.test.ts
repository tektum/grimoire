// @vitest-environment node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

/** The `app` environment `docker compose config` resolves for a set of files (it renders only; no engine is needed). */
function appEnvironment(files: string[]): Record<string, string> {
  const args = ['compose', '--project-directory', root, '--env-file', path.join(root, '.env.example'), ...files.flatMap((f) => ['-f', path.join(root, f)]), 'config', '--format', 'json'];
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', DOCKER_CONFIG: process.env['DOCKER_CONFIG'] ?? '', GRIMOIRE_DEV_DB_PASSWORD: 'x'.repeat(16) },
  });
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { services: { app: { environment: Record<string, string> } } }).services.app.environment;
}

describe('compose.yaml with compose.m6.yaml', () => {
  it('renders, with the two 4173 origins and the defaults of the plain stack', () => {
    const env = appEnvironment(['compose.yaml', 'compose.m6.yaml']);
    expect(env['GRIMOIRE_ALLOWED_ORIGINS']).toBe('http://127.0.0.1:4173,http://localhost:4173');
    expect([env['GRIMOIRE_MIN_CLIENT_VERSION'], env['GRIMOIRE_REQUIRE_HANDSHAKE'], env['GRIMOIRE_COLLAB_RECHECK_SECONDS'], env['GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE']]).toEqual([
      '0.0.0',
      '0',
      '60',
      '100',
    ]);
  });

  it('changes nothing else of the app environment', () => {
    const plain = appEnvironment(['compose.yaml']);
    const withOverlay = appEnvironment(['compose.yaml', 'compose.m6.yaml']);
    const changed = Object.keys({ ...plain, ...withOverlay }).filter((k) => plain[k] !== withOverlay[k]);
    // The connection cap is empty in the plain stack (the settings default applies, 100); the other three are not passed there at all or already equal.
    expect(changed.sort()).toEqual(['GRIMOIRE_ALLOWED_ORIGINS', 'GRIMOIRE_COLLAB_MAX_CONNECTIONS_PER_PAGE', 'GRIMOIRE_MIN_CLIENT_VERSION', 'GRIMOIRE_REQUIRE_HANDSHAKE']);
  });
});
