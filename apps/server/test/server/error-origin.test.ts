import { describe, expect, it } from 'vitest';
import { errorOrigin } from '../../src/events.js';

const withStack = (stack: string): Error => Object.assign(new Error('secret message hunter2'), { stack });

describe('errorOrigin', () => {
  it('is the first frame in our code as a repository-relative file:line, never the message', () => {
    const e = withStack([
      'Error: secret message hunter2',
      '    at new Request (node:internal/deps/undici/undici:13456:19)',
      '    at bodyLimit (file:///app/node_modules/hono/dist/middleware/body-limit/index.js:62:15)',
      '    at fail (/home/runner/work/grimoire/grimoire/apps/server/src/http/error.ts:82:9)',
      '    at /home/runner/work/grimoire/grimoire/apps/server/src/routes/pages.ts:142:14',
    ].join('\n'));
    expect(errorOrigin(e)).toBe('apps/server/src/http/error.ts:82');
  });
  it('reads file URLs and package paths', () => {
    expect(errorOrigin(withStack('Error: x\n    at async file:///app/packages/adapters/db-kysely/dist/pages.js:230:21'))).toBe('packages/adapters/db-kysely/dist/pages.js:230');
    expect(errorOrigin(withStack('Error: x\n    at async file:///app/apps/server/dist/http/rate-limit.js:45:9'))).toBe('apps/server/dist/http/rate-limit.js:45');
  });
  it('is undefined when no frame is ours, there is no stack, or the value is not an Error', () => {
    expect(errorOrigin(withStack('Error: x\n    at node:internal/a:1:1\n    at file:///app/node_modules/hono/dist/compose.js:35:11'))).toBeUndefined();
    expect(errorOrigin(withStack(''))).toBeUndefined();
    expect(errorOrigin('a string')).toBeUndefined();
  });
});
