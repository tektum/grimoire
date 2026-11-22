import { describe, expect, it } from 'vitest';
import { createJsonLogger } from '@tektum/grimoire-adapter-logger-json';
import { createEventLog } from '../../src/events.js';
import { compose } from '../../src/composition.js';
import { createRun } from '../../src/lifecycle/run.js';

const base = {
  GRIMOIRE_LOCAL: '1',
  GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
  GRIMOIRE_DATABASE_URL: 'postgresql://u:pw@127.0.0.1:55432/grimoire',
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
};

async function logLine(env: Record<string, string>): Promise<string> {
  const lines: string[] = [];
  const log = createEventLog(createJsonLogger({ destination: { write: (l) => lines.push(l) } }));
  const c = compose(env);
  if (c.ok) throw new Error('expected a refusal');
  await createRun({ compose: () => ({ ...c, log }), exit: () => undefined })();
  return lines.join('');
}

describe('server.config_invalid log line', () => {
  it.each([
    ['GRIMOIRE_COLLAB_PREAUTH_TIMEOUT_SECONDS', '0', 'must be an integer'],
    ['GRIMOIRE_DESCOPE_MAX_TOKEN_LIFETIME_SECONDS', '-1', 'must be an integer'],
  ])('shows the rule for %s', async (name, value, rule) => {
    const line = await logLine({ ...base, [name]: value });
    expect(line).toContain(name);
    expect(line).toContain(rule);
    expect(line).not.toContain('[redacted]');
  });

  it('still hides a secret value', async () => {
    const line = await logLine({ ...base, GRIMOIRE_DESCOPE_MANAGEMENT_KEY: 'sekrit-value-123', GRIMOIRE_DESCOPE_BASE_URL: 'nope' });
    expect(line).not.toContain('sekrit-value-123');
  });
});
