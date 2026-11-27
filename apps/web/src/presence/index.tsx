import { useEffect, useState, type CSSProperties } from 'react';
import type { Directory } from '../editor/core/directory';
import { COLLAB_COLOURS, colourIndex, labelText } from '../ui/collab';
import { MAX_DISCS, NAMED_UP_TO, announcementOf, firstNames, initialsOf, othersOf, type AwarenessSource } from './model';
import './presence.css';

export { awarenessOf, jumpTo, type AwarenessSource } from './model';

/** Joining and leaving are told once things have been still for this long: several changes in the window are one sentence. */
export const ANNOUNCE_DELAY_MS = 1000;

/** Where presence comes from: the awareness of the page's provider, and the directory the names come from. */
export interface PresenceSource {
  readonly source: AwarenessSource;
  readonly directory: Directory;
}

export interface Person {
  readonly id: string;
  readonly name: string;
  /** Index into the collaborator colours. */
  readonly colour: number;
}

/**
 * The other people on the page and the latest sentence about who joined or left. Moving carets change the awareness all the time; only a change of who is here
 * renders again. The people here when the source arrives are not announced.
 */
export function usePresence(presence: PresenceSource | null, self: string | null): { people: readonly Person[]; announcement: string } {
  const [ids, setIds] = useState<readonly string[]>([]);
  const [, setNames] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (presence === null) {
      setIds([]); // the document is gone: nobody of it is shown or announced
      setAnnouncement('');
      return undefined;
    }
    const { source, directory } = presence;
    let current = othersOf(source, self);
    let baseline = current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setIds(current);
    setAnnouncement(''); // nothing said by an earlier document is replayed, and the same sentence can be said again
    const announce = (): void => {
      const joined = current.filter((id) => !baseline.includes(id)).map((id) => directory.nameOf(id));
      const left = baseline.filter((id) => !current.includes(id)).map((id) => directory.nameOf(id));
      baseline = current;
      const text = announcementOf(joined, left);
      if (text !== null) setAnnouncement(text);
    };
    const onChange = (): void => {
      const next = othersOf(source, self);
      if (next.join(' ') === current.join(' ')) return; // a caret moved: nobody came or went
      current = next;
      setIds(next);
      clearTimeout(timer);
      timer = setTimeout(announce, ANNOUNCE_DELAY_MS);
    };
    source.on('change', onChange);
    return () => {
      source.off('change', onChange);
      clearTimeout(timer);
    };
  }, [presence, self]);

  useEffect(() => {
    if (presence === null) return undefined;
    presence.directory.request(ids);
    return presence.directory.subscribe(() => setNames((n) => n + 1));
  }, [presence, ids]);

  const people = presence === null ? [] : ids.map((id) => ({ id, name: presence.directory.nameOf(id), colour: colourIndex(id) }));
  return { people, announcement };
}

const discStyle = (colour: number): CSSProperties => ({ '--presence-colour': `var(--collab-${String(colour)})`, '--presence-text': labelText(COLLAB_COLOURS[colour]!) }) as CSSProperties;

/**
 * The people on the page as a stack of initials discs, at most {@link MAX_DISCS} and then "+N". Each disc is a button named after the person that brings their caret
 * into view; with two people or fewer their first names show beside the stack. Nothing when nobody else is here.
 */
export function PresenceStack({ people, onJump }: { readonly people: readonly Person[]; readonly onJump: (id: string) => void }) {
  if (people.length === 0) return null;
  const rest = people.slice(MAX_DISCS);
  const restNames = rest.map((p) => p.name).join(', ');
  return (
    <div className="presence">
      <div className="presence-discs">
        {people.slice(0, MAX_DISCS).map((person) => (
          <button key={person.id} type="button" className="presence-disc" aria-label={person.name} title={person.name} style={discStyle(person.colour)} onClick={() => onJump(person.id)}>
            <span aria-hidden="true">{initialsOf(person.name)}</span>
          </button>
        ))}
        {rest.length > 0 ? (
          <span className="presence-disc presence-more" role="img" aria-label={restNames} title={restNames}>
            +{rest.length}
          </span>
        ) : null}
      </div>
      {/* The buttons already carry the names: the words are for the eye only. */}
      {people.length <= NAMED_UP_TO ? (
        <span className="presence-names" aria-hidden="true">
          {firstNames(people.map((p) => p.name))}
        </span>
      ) : null}
    </div>
  );
}

/** The one polite live region for presence: who joined and who left, apart from the save status. */
export function PresenceAnnouncer({ text }: { readonly text: string }) {
  return (
    <p className="presence-announcer" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </p>
  );
}
