import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The parts of the top bar that belong to the open page, in the order they sit: the bar has one fixed place for each, so they never change order whenever each one arrives. */
export const PARTS = ['status', 'presence', 'history', 'menu'] as const;
export type Part = (typeof PARTS)[number];

type Places = Partial<Record<Part, HTMLElement>>;
/** Null where there is no bar (a page mounted alone): the controls then stay where the page puts them. */
const PlacesContext = createContext<{ places: Places; set: (part: Part, el: HTMLElement | null) => void }>({ places: {}, set: () => undefined });

const BAR = '(min-width: 40.0625rem)';

export function PageControlsProvider({ children }: { children: ReactNode }) {
  const [places, setPlaces] = useState<Places>({});
  const set = useCallback((part: Part, el: HTMLElement | null) => {
    setPlaces((current) => {
      if ((current[part] ?? null) === el) return current;
      const next = { ...current };
      if (el === null) delete next[part];
      else next[part] = el;
      return next;
    });
  }, []);
  const value = useMemo(() => ({ places, set }), [places, set]);
  return <PlacesContext.Provider value={value}>{children}</PlacesContext.Provider>;
}

function PartHolder({ part, set }: { part: Part; set: (part: Part, el: HTMLElement | null) => void }) {
  const ref = useCallback((el: HTMLDivElement | null) => { set(part, el); }, [part, set]); // one function for the life of the holder: a new one each render would detach and attach again
  return <div className="shell-page-part" data-part={part} ref={ref} />;
}

/** Where the controls land in the top bar: one holder per part (`display: contents`, so the parts are the bar's flex items), in a fixed order. */
export function PageControlsSlot() {
  const { set } = useContext(PlacesContext);
  return (
    <div className="shell-page-controls">
      {PARTS.map((part) => (
        <PartHolder key={part} part={part} set={set} />
      ))}
    </div>
  );
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
 * Puts `children` in the bar's place for `part` when there is a bar (and `show` holds), else right here. `barOnly` renders nothing where it would not go in the bar.
 */
export function InBar({ part, children, show = true, barOnly = false }: { part: Part; children: ReactNode; show?: boolean; barOnly?: boolean }) {
  const place = useContext(PlacesContext).places[part];
  if (place !== undefined && show) return createPortal(children, place);
  return barOnly ? null : <>{children}</>;
}

/**
 * One piece of the page that lives in the bar when it has room and under the title otherwise, as the same DOM node (and the same component instance) either way, so
 * what it is in the middle of (a "Saving" waiting out its delay) survives a window being widened or a phone turned.
 */
export function Movable({ part, inBar, children }: { part: Part; inBar: boolean; children: ReactNode }) {
  const place = useContext(PlacesContext).places[part];
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.style.display = 'contents';
    return el;
  });
  const [inline, setInline] = useState<HTMLElement | null>(null);
  const target = place !== undefined && inBar ? place : inline;
  useEffect(() => {
    if (target !== null && host.parentElement !== target) target.appendChild(host);
  }, [target, host]);
  return (
    <>
      <div ref={setInline} style={{ display: 'contents' }} />
      {createPortal(children, host)}
    </>
  );
}
