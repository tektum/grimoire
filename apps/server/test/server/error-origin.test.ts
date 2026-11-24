import { describe, expect, it } from 'vitest';
import { errorOrigin } from '../../src/events.js';

const withStack = (stack: string): Error => Object.assign(new Error('secret message hunter2'), { stack });
/** An error whose real engine stack is `Error: <message>` followed by the given frames. */
const withMessage = (message: string, frames: string): Error => Object.assign(new Error(message), { stack: `Error: ${message}\n${frames}` });

describe('errorOrigin', () => {
  it('is the first frame in our code (not the error-building helper) as a repository-relative file:line', () => {
    const e = withStack([
      'Error: secret message hunter2',
      '    at new Request (node:internal/deps/undici/undici:13456:19)',
      '    at bodyLimit (file:///srv/node_modules/hono/dist/middleware/body-limit/index.js:62:15)',
      '    at fail (/repo/apps/server/src/http/error.ts:82:9)',
      '    at /repo/apps/server/src/routes/pages.ts:142:14',
    ].join('\n'));
    expect(errorOrigin(e)).toBe('apps/server/src/routes/pages.ts:142');
  });
  it('reads file URLs and package paths', () => {
    expect(errorOrigin(withMessage('x', '    at async file:///srv/packages/adapters/db-kysely/dist/pages.js:230:21'))).toBe('packages/adapters/db-kysely/dist/pages.js:230');
    expect(errorOrigin(withMessage('x', '    at async file:///srv/apps/server/dist/http/rate-limit.js:45:9'))).toBe('apps/server/dist/http/rate-limit.js:45');
  });
  it('is undefined when no frame is ours, there is no stack, or the value is not an Error', () => {
    expect(errorOrigin(withMessage('x', '    at node:internal/a:1:1\n    at file:///srv/node_modules/hono/dist/compose.js:35:11'))).toBeUndefined();
    expect(errorOrigin(withStack(''))).toBeUndefined();
    expect(errorOrigin('a string')).toBeUndefined();
  });
  it('never reads the message, even one that looks like a frame', () => {
    const frames = '    at /repo/apps/server/src/routes/pages.ts:142:14';
    expect(errorOrigin(withMessage('could not read /apps/user-value:1:1', frames))).toBe('apps/server/src/routes/pages.ts:142');
    expect(errorOrigin(withMessage('first\n    at /repo/apps/forged/file.ts:9:9', frames))).toBe('apps/server/src/routes/pages.ts:142');
    expect(errorOrigin(withMessage('only a message /apps/user-value:1:1', ''))).toBeUndefined();
    expect(errorOrigin(Object.assign(new Error('m'), { stack: 'not the engine shape\n    at /repo/apps/a.ts:1:1' }))).toBeUndefined();
  });
  it('reads the frames of an error with an empty message (the header is just the name)', () => {
    const e = Object.assign(new Error(''), { stack: 'Error\n    at /repo/apps/server/src/routes/pages.ts:142:14' });
    expect(errorOrigin(e)).toBe('apps/server/src/routes/pages.ts:142');
  });
});
