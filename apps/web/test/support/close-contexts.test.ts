import { describe, expect, it } from 'vitest';
import { closeContexts } from '../../test-e2e/support/close-contexts';

const context = (log: string[], name: string, error?: Error) => ({
  close: () => {
    log.push(`close ${name}`);
    return error === undefined ? Promise.resolve() : Promise.reject(error);
  },
});

describe('closing the contexts of a test', () => {
  it('closes each one, in order, one after the other', async () => {
    const log: string[] = [];
    let open = 0;
    let most = 0;
    const slow = (name: string) => ({
      close: async () => {
        open += 1;
        most = Math.max(most, open);
        log.push(`close ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
      },
    });
    await closeContexts([slow('a'), slow('b')]);
    expect(log).toEqual(['close a', 'close b']);
    expect(most).toBe(1);
  });

  it.each(['Protocol error (Target.disposeBrowserContext): Failed to find context', 'browserContext.close: Target page, context or browser has been closed'])(
    'treats a context that is gone (%s) as closed, and still closes the other',
    async (message) => {
      const log: string[] = [];
      await closeContexts([context(log, 'a', new Error(message)), context(log, 'b')]);
      expect(log).toEqual(['close a', 'close b']);
    },
  );

  it('throws any other failure, the first, after every context was tried', async () => {
    const log: string[] = [];
    await expect(closeContexts([context(log, 'a', new Error('disk full')), context(log, 'b', new Error('second')), context(log, 'c')])).rejects.toThrow('disk full');
    expect(log).toEqual(['close a', 'close b', 'close c']);
  });
});
