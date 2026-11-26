import os from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, freePort, get, mainJs, requireBuild, runToEnd, startServer,
} from './support/harness.js';
import { eventually, listenerReport, TRACK_LISTENERS } from '@tektum/grimoire-test-support/harness';
import type { ServerProcess } from './support/harness.js';

const DB = 'grimoire_t07_host';
const running: ServerProcess[] = [];
const dbEnv = { GRIMOIRE_DATABASE_URL: appUrl(DB) };

async function start(env: Record<string, string>): Promise<ServerProcess> {
  const s = await startServer({ env: { ...dbEnv, ...env }, nodeArgs: ['--import', TRACK_LISTENERS] });
  running.push(s);
  return s;
}
const external = Object.values(os.networkInterfaces()).flat().find((i) => i !== undefined && i.family === 'IPv4' && !i.internal)?.address;
const names = (s: ServerProcess) => s.events.map((e) => e['event']);

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
}, 60_000);
afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.kill())); });
afterAll(async () => { await dropTestDatabase(DB); });

describe('GRIMOIRE_HOST', () => {
  it('unset binds loopback only: loopback answers, and the process listens on the loopback address alone', async () => {
    const s = await start({ GRIMOIRE_HOST: '' }); // empty counts as unset: the default applies
    expect(s.events.find((e) => e['event'] === 'http.listening')).toMatchObject({ bindHost: '127.0.0.1', service: 'grimoire', env: 'local' });
    expect(await get(`http://127.0.0.1:${s.port}/healthz`)).toEqual({ status: 200, body: 'ok' });
    // What the process itself listens on (it reports it on SIGUSR2): loopback only, one address. No probe of the machine's other address, which another test may have bound.
    s.signal('SIGUSR2');
    await eventually(async () => (listenerReport(s.output) === undefined ? undefined : true), 4000, 'the listener report');
    expect(listenerReport(s.output)?.addresses).toEqual([`127.0.0.1:${String(s.port)}`]);
  });

  it('0.0.0.0 binds all interfaces', async (ctx) => {
    if (external === undefined) ctx.skip('this machine has no non-loopback IPv4 address to probe');
    const s = await start({ GRIMOIRE_HOST: '0.0.0.0', GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK: '1' });
    expect(await get(`http://${external}:${s.port}/healthz`)).toEqual({ status: 200, body: 'ok' });
    expect(await get(`http://127.0.0.1:${s.port}/healthz`)).toEqual({ status: 200, body: 'ok' });
  });

  it('server.local_mode_exposed appears only for local mode plus a non-loopback host', async () => {
    const exposed = await start({ GRIMOIRE_HOST: '0.0.0.0', GRIMOIRE_LOCAL: '1', GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK: '1' });
    expect(exposed.events.find((e) => e['event'] === 'server.local_mode_exposed')).toMatchObject({ level: 'warn', bindHost: '0.0.0.0' });
    const loopback = await start({ GRIMOIRE_HOST: '127.0.0.1', GRIMOIRE_LOCAL: '1' });
    expect(names(loopback)).not.toContain('server.local_mode_exposed');
    const nonLocal = await start({ GRIMOIRE_HOST: '0.0.0.0', GRIMOIRE_LOCAL: '0', GRIMOIRE_ROLE: 'api', GRIMOIRE_DESCOPE_PROJECT_ID: 'P2abc', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test', GRIMOIRE_ENV: 'staging' });
    expect(names(nonLocal)).not.toContain('server.local_mode_exposed');
    const listening = nonLocal.events.find((e) => e['event'] === 'http.listening');
    expect(listening).toMatchObject({ bindHost: '0.0.0.0', service: 'grimoire', env: 'staging' });
    expect(listening).not.toHaveProperty('host'); // `host` is the log pipeline's own attribute (where the line comes from)
  });

  it('local mode on a non-loopback host refuses to start (exit 2, one fixed line, no listening) unless GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK=1', async () => {
    const port = await freePort();
    const exit = await runToEnd([mainJs], { ...dbEnv, GRIMOIRE_PORT: String(port), GRIMOIRE_LOCAL: '1', GRIMOIRE_HOST: '0.0.0.0' });
    expect(exit.code).toBe(2);
    expect(exit.output).toContain('"setting":"GRIMOIRE_HOST"');
    expect(exit.output).toContain('is not a loopback address in local mode');
    expect(exit.output).not.toContain('http.listening');
  });

  it('local mode without GRIMOIRE_DEV_TOKEN_SECRET refuses to start (exit 2)', async () => {
    const port = await freePort();
    const exit = await runToEnd([mainJs], { ...dbEnv, GRIMOIRE_PORT: String(port), GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: '' });
    expect(exit.code).toBe(2);
    expect(exit.output).toContain('"setting":"GRIMOIRE_LOCAL"');
    expect(exit.output).toContain('needs GRIMOIRE_DEV_TOKEN_SECRET to be set');
  });

  it('an IPv4-mapped loopback host does not log server.local_mode_exposed', async () => {
    const s = await start({ GRIMOIRE_HOST: '::ffff:127.0.0.1', GRIMOIRE_LOCAL: '1' });
    expect(names(s)).toContain('http.listening');
    expect(names(s)).not.toContain('server.local_mode_exposed');
  });

  it('a bind to an address the machine does not have exits 1 with server.start_failed and no exposure warning', async () => {
    const port = await freePort();
    const exit = await runToEnd([mainJs], { ...dbEnv, GRIMOIRE_PORT: String(port), GRIMOIRE_LOCAL: '1', GRIMOIRE_HOST: '192.0.2.1', GRIMOIRE_LOCAL_ALLOW_NON_LOOPBACK: '1' }); // TEST-NET-1: never assigned locally
    expect(exit.code).toBe(1);
    expect(exit.output).toContain('"event":"server.start_failed"');
    expect(exit.output).toContain('"bindHost":"192.0.2.1"');
    expect(exit.output).not.toContain('"host":'); // `host` is a log pipeline's own attribute, so the logger drops it from fields
    expect(exit.output).toContain(`"port":${String(port)}`);
    expect(exit.output).not.toContain('server.local_mode_exposed');
  });

  it.each(['localhost', 'example.test', '999.1.1.1', ' ', '127.0.0.1:8080'])('refuses %j with exit 2 naming GRIMOIRE_HOST, before listening', async (host) => {
    const port = await freePort();
    const exit = await runToEnd([mainJs], { ...dbEnv, GRIMOIRE_PORT: String(port), GRIMOIRE_LOCAL: '1', GRIMOIRE_HOST: host });
    expect(exit.code).toBe(2);
    expect(exit.output).toContain('GRIMOIRE_HOST');
    expect(exit.output).not.toContain('http.listening');
  });
});
