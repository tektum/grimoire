const PREFIX = 'grimoire.';

/** The one place the client keeps its own small preferences (R11.27). Keys are prefixed; storage that is blocked or full is ignored. */
export interface ClientStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** `localStorage` itself can throw on access (site data blocked, for example in an embedded frame): then there is no backend. */
const defaultBackend = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function createClientStorage(backend: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = defaultBackend()): ClientStorage {
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
