import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The top bar's room for the open page's own controls (save status, presence, History, page menu). Null where there is no bar (a page mounted alone): they then stay where the page puts them. */
const SlotContext = createContext<{ slot: HTMLElement | null; set: (el: HTMLElement | null) => void }>({ slot: null, set: () => undefined });

const BAR = '(min-width: 40.0625rem)';

export function PageControlsProvider({ children }: { children: ReactNode }) {
  const [slot, set] = useState<HTMLElement | null>(null);
  return <SlotContext.Provider value={{ slot, set }}>{children}</SlotContext.Provider>;
}

/** Where the controls land in the top bar. `display: contents`, so they are its flex items. */
export function PageControlsSlot() {
  const { set } = useContext(SlotContext);
  return <div className="shell-page-controls" ref={set} />;
}

/** True from 641px up, where the whole set sits in the bar; on a phone only presence and the menu do, the save status keeps its own line under the title. */
export function useBarRoom(): boolean {
  const [room, setRoom] = useState(() => window.matchMedia(BAR).matches);
  useEffect(() => {
    const query = window.matchMedia(BAR);
    const update = (): void => { setRoom(query.matches); };
    query.addEventListener('change', update);
    return () => { query.removeEventListener('change', update); };
  }, []);
  return room;
}

/**
 * Puts `children` in the top bar when there is one (and `show` holds), else right here. `barOnly` renders nothing where it would not go in the bar; `fallbackOnly` is
 * its twin, rendering only where `barOnly` would not: a control that has two places, the bar and the page.
 */
export function InBar({ children, show = true, barOnly = false, fallbackOnly = false }: { children: ReactNode; show?: boolean; barOnly?: boolean; fallbackOnly?: boolean }) {
  const { slot } = useContext(SlotContext);
  const inBar = slot !== null && show;
  if (inBar) return fallbackOnly ? null : createPortal(children, slot);
  return barOnly ? null : <>{children}</>;
}
