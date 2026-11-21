/**
 * Milkdown's context timers dispatch events on the global object (`@milkdown/ctx`), which Node does not have. Bind the
 * three functions it uses to a plain `EventTarget`; nothing else of a browser is needed (measured: docs/proof/m2-conversion.md).
 * Hand-written because no upstream API exists. Idempotent, and leaves real implementations (a DOM) alone.
 */
export function installEventGlobals(): void {
  const target = new EventTarget();
  const define = (name: string, value: unknown): void => {
    if (typeof Reflect.get(globalThis, name) === 'function') return;
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  define('addEventListener', (...args: Parameters<EventTarget['addEventListener']>) => {
    target.addEventListener(...args);
  });
  define('removeEventListener', (...args: Parameters<EventTarget['removeEventListener']>) => {
    target.removeEventListener(...args);
  });
  define('dispatchEvent', (event: Event) => target.dispatchEvent(event));
}
