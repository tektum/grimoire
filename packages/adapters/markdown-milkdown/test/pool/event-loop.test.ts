import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { createMarkdownConverter } from '../../src/index.js';
import { generateMarkdown } from '../../src/testing/generate.js';
import { stateFromMarkdown } from '../../src/testing/states.js';
import { ensureBuilt } from './support.js';

beforeAll(ensureBuilt);

const RESULT = fileURLToPath(new URL('../../../../../test-results/m2/pool-1mb.json', import.meta.url));

it('a cap-sized conversion (0.9 MB of Markdown, a 1.5 MB state: the largest page the server accepts) in the pool leaves the main thread answering: GET /ping within 500 ms (median under 100 ms), event-loop delay under 500 ms', async () => {
  const state = await stateFromMarkdown(generateMarkdown('prose', 880_000));
  const converter = createMarkdownConverter({ timeoutMs: 10_000 });
  const server = createServer((_request, response) => response.end('pong'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  try {
    // Warm the worker first so the measured call is the conversion, not the start-up.
    await converter.seed('warm', 'test-key');
    delay.enable();
    const started = performance.now();
    const conversion = converter.toMarkdown(state);
    const pings: number[] = [];
    let done = false;
    void conversion.then(() => {
      done = true;
    });
    while (!done) {
      const sent = performance.now();
      const reply = await fetch(`http://127.0.0.1:${port}/ping`);
      await reply.text();
      pings.push(performance.now() - sent);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await conversion;
    const elapsedMs = performance.now() - started;
    delay.disable();
    const maxPingMs = Math.max(...pings);
    const maxLoopDelayMs = delay.max / 1e6;
    mkdirSync(fileURLToPath(new URL('.', `file://${RESULT}`)), { recursive: true });
    writeFileSync(RESULT, `${JSON.stringify({ stateBytes: state.byteLength, ok: result.ok, elapsedMs: Math.round(elapsedMs), pings: pings.length, maxPingMs: Math.round(maxPingMs), maxLoopDelayMs: Math.round(maxLoopDelayMs) }, null, 2)}\n`);
    expect(result.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
    expect(pings.length).toBeGreaterThan(3);
    // Why 500 ms: with the conversion on the main thread the loop stays blocked for the whole conversion (1.5 s idle, seconds on a slow runner), so any
    // gap or ping above 500 ms means the work is not off the main thread. Idle it measures 20-40 ms; a shared runner showed 104 ms once (a pause that is not the
    // conversion), which a 100 ms bound turned into a failure. The typical ping stays tight: the median must be under 100 ms.
    const median = [...pings].sort((a, b) => a - b)[Math.floor(pings.length / 2)] ?? Number.POSITIVE_INFINITY;
    expect(median, `median ping ${String(Math.round(median))} ms`).toBeLessThan(100);
    expect(maxPingMs, `max ping ${String(Math.round(maxPingMs))} ms`).toBeLessThan(500);
    expect(maxLoopDelayMs, `max loop delay ${String(Math.round(maxLoopDelayMs))} ms`).toBeLessThan(500);
  } finally {
    await converter.close();
    await new Promise((resolve) => server.close(resolve));
  }
}, 30_000);
