import type { Extension, Hocuspocus } from '@hocuspocus/server';
import type { ShutdownReport } from '@tektum/grimoire-core/ports/collaboration-host';
import type { CollabLog } from '../events.js';

export interface Lifecycle {
  readonly extension: Extension;
  /** The Hocuspocus instance is built from the extensions, so it is handed over once it exists. */
  bind(hocuspocus: Hocuspocus): void;
  /**
   * The shutdown sequence the Hocuspocus class lacks: wait until no document is loaded (closing the last connection of a page already stores it at once: `unloadImmediately` in Hocuspocus, shown by the "before the debounce" test, so no separate flush),
   * give up at the deadline (then `abandon` stops the retry loops and each loaded page with unsaved changes is reported), run `onDestroy`.
   */
  saveAll(o: { deadlineMs: number; abandon: () => void; unsaved: () => string[] }): Promise<ShutdownReport>;
}

export function createLifecycle(log: CollabLog): Lifecycle {
  let bound: Hocuspocus | undefined;
  const checks = new Set<() => void>();
  const extension: Extension = {
    extensionName: 'grimoire-lifecycle',
    priority: 50,
    // Hocuspocus has no "all documents unloaded" signal; this wakes the waiter in saveAll.
    async afterUnloadDocument(): Promise<void> {
      for (const check of [...checks]) check();
    },
  };

  const allUnloaded = (hocuspocus: Hocuspocus, deadlineMs: number): Promise<boolean> => new Promise((resolve) => {
    const done = (value: boolean): void => { clearTimeout(timer); checks.delete(check); resolve(value); };
    const check = (): void => { if (hocuspocus.getDocumentsCount() === 0) done(true); };
    const timer = setTimeout(() => { done(false); }, deadlineMs);
    checks.add(check);
    check();
  });

  return {
    extension,
    bind(hocuspocus) { bound = hocuspocus; },
    async saveAll({ deadlineMs, abandon, unsaved }) {
      const hocuspocus = bound;
      if (!hocuspocus) return { abandonedPages: 0 };
      let abandonedPages = 0;
      if (!(await allUnloaded(hocuspocus, deadlineMs))) {
        abandon();
        const pending = new Set(unsaved());
        for (const pageId of hocuspocus.documents.keys()) {
          if (!pending.has(pageId)) continue; // still loaded but already stored: nothing is lost
          log.emit('collab.store_abandoned', { pageId });
          abandonedPages++;
        }
      }
      await hocuspocus.hooks('onDestroy', { instance: hocuspocus });
      return { abandonedPages };
    },
  };
}
