const PREFIX = 'grimoire.';

/** The one place the client keeps its own small preferences (R11.27). Keys are prefixed; storage that is blocked or full is ignored. */
export interface ClientStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function createClientStorage(backend: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): ClientStorage {
  const guard = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    get: (key) => guard(() => backend?.getItem(PREFIX + key) ?? null, null),
    set: (key, value) => guard(() => backend?.setItem(PREFIX + key, value), undefined),
    remove: (key) => guard(() => backend?.removeItem(PREFIX + key), undefined),
  };
}
