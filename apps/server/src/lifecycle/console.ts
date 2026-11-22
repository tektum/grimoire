import type { ConsoleMethod, EventLog } from '../events.js';

const METHODS: readonly ConsoleMethod[] = ['log', 'info', 'debug', 'warn', 'error'];

/**
 * @hono/node-server reports response-stream failures and client aborts with console.error / console.info and offers
 * no hook for them. Without this they would reach stderr as free text (possibly carrying an error object), so every
 * console call becomes a named event carrying only the method; the arguments are dropped on purpose.
 */
export function routeConsoleToEvents(log: EventLog, target: Console = console): void {
  for (const method of METHODS) {
    target[method] = (): void => {
      if (method === 'error' || method === 'warn') log.warn('console.error_output', { method });
      else log.debug('console.info_output', { method });
    };
  }
}
