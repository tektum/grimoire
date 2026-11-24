import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { describe, expect, it } from 'vitest';
import { createSaver } from '../../src/save.js';
import { createCollabLog } from '../../src/events.js';

function run(breaker: { disabled?: boolean } | undefined) {
  const converter = new FakeMarkdownConverter();
  for (let i = 0; i < 4; i++) converter.enqueueConvert({ ok: false, reason: 'timeout', detail: 'the conversion exceeded its time limit' });
  const events: string[] = [];
  const log = createCollabLog({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: (e: string) => { events.push(e); } } as never);
  const saver = createSaver({ converter: Object.assign(converter, { waiting: () => 0 }), log, ...(breaker ? { breaker } : {}) });
  return { converter, events, saver };
}

describe('the breaker, and the test-only switch that disables it', () => {
  it('by default the first timeout opens it and the next saves convert nothing', async () => {
    const r = run(undefined);
    await r.saver.convert('p', new Uint8Array(10));
    await r.saver.convert('p', new Uint8Array(10));
    expect(r.converter.convertCalls).toHaveLength(1);
    expect(r.events.filter((e) => e === 'collab.convert_breaker_open')).toHaveLength(1);
  });

  it('disabled: every save converts (and times out) again and the breaker never opens', async () => {
    const r = run({ disabled: true });
    for (let i = 0; i < 4; i++) await r.saver.convert('p', new Uint8Array(10));
    expect(r.converter.convertCalls).toHaveLength(4);
    expect(r.events).not.toContain('collab.convert_breaker_open');
  });
});
