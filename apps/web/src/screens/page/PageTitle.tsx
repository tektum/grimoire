import { useEffect, useRef, useState } from 'react';

/** The longest title (R3.21): 1 to 255 characters. */
export const TITLE_MAX = 255;

/**
 * The title of the page, the main heading. For a person who may edit the page it is a button: activate it (click, Enter or Space) and the title becomes a field, with the
 * title in it selected. Enter saves, Escape puts the field away and keeps the title, and leaving the field saves what is in it (an empty field, or the same title, saves nothing).
 * A title is a plain field of the page (R14.6), edited through the API like the tree's rename: it is not taken from the first heading of the text. A page nobody has named shows
 * "Untitled"; a new page opens with the empty field focused (`startEditing`).
 */
export function PageTitle({ title, editable, startEditing, onSave }: { title: string; editable: boolean; startEditing: boolean; onSave: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(editable && startEditing);
  const [saving, setSaving] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  const returnFocus = useRef(false);
  const shown = title === '' ? 'Untitled' : title;

  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      button.current?.focus();
    }
  }, [editing]);
  // Someone who may no longer edit the page (its permission was read again) cannot go on editing it.
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);

  if (!editable) return <h1 id="screen-title">{shown}</h1>;

  if (!editing) {
    return (
      <h1 id="screen-title">
        <button
          ref={button}
          type="button"
          className="page-title-button"
          data-untitled={title === '' ? 'true' : undefined}
          title="Rename this page"
          onClick={() => {
            finished.current = false;
            setEditing(true);
          }}
        >
          {shown}
        </button>
      </h1>
    );
  }

  /** Ends the editing: saves `value` (or not), and gives the focus back to the button only when the person ended it with a key (`refocus`), never when they left the field for somewhere else. */
  const finish = async (value: string, { save, refocus }: { save: boolean; refocus: boolean }) => {
    if (finished.current) return;
    finished.current = true;
    const next = value.trim();
    if (!save || next === '' || next === title.trim()) {
      returnFocus.current = refocus;
      setEditing(false);
      return;
    }
    setSaving(true);
    await onSave(next);
    setSaving(false);
    returnFocus.current = refocus;
    setEditing(false);
  };

  return (
    <h1 id="screen-title" aria-label="Page title">
      <input
        className="page-title-input"
        aria-label="Page title"
        placeholder="Untitled"
        defaultValue={title}
        maxLength={TITLE_MAX}
        disabled={saving}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => void finish(e.currentTarget.value, { save: true, refocus: false })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            void finish(e.currentTarget.value, { save: false, refocus: true });
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void finish(e.currentTarget.value, { save: true, refocus: true });
          }
        }}
      />
    </h1>
  );
}
