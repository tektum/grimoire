import { useEffect, useRef, useState } from 'react';
import { Bold, Code, Italic, Link, Strikethrough } from 'lucide-react';
import { INLINE_KINDS, type InlineKind } from './marks';

const ICONS = { bold: Bold, italic: Italic, strike: Strikethrough, code: Code } as const;
export const LINK_ERROR_ID = 'bubble-link-error';

export interface BubbleProps {
  readonly active: Readonly<Record<InlineKind, boolean>>;
  /** The address of the link the selection is in, or null. */
  readonly link: string | null;
  readonly mode: 'format' | 'link';
  /** The refusal to show in the link editor, or null. */
  readonly refusal: string | null;
  onToggle(kind: InlineKind): void;
  onOpenLink(): void;
  /** Applies what was typed; the answer decides whether the editor closes (the host keeps it open on a refusal). */
  onApply(address: string): void;
  onCancel(): void;
}

/**
 * The bubble over a selection: inline formatting, and the link editor. It is a toolbar of toggle buttons; the buttons do not take the focus from the text (the press is
 * the editor's), except the address field, which does.
 */
export function Bubble(props: BubbleProps) {
  if (props.mode === 'link') return <LinkEditor {...props} />;
  return (
    <div role="toolbar" aria-label="Text formatting" className="bubble-bar" onMouseDown={(event) => event.preventDefault()}>
      {INLINE_KINDS.map((kind) => {
        const Icon = ICONS[kind.id];
        return (
          <button key={kind.id} type="button" className="bubble-button" aria-label={kind.label} aria-pressed={props.active[kind.id]} onClick={() => props.onToggle(kind.id)}>
            <Icon size={16} aria-hidden="true" />
          </button>
        );
      })}
      <button type="button" className="bubble-button" aria-label="Link" aria-pressed={props.link !== null} onClick={props.onOpenLink}>
        <Link size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

function LinkEditor(props: BubbleProps) {
  const [value, setValue] = useState(props.link ?? '');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <form
      className="bubble-link"
      aria-label="Link"
      onSubmit={(event) => {
        event.preventDefault();
        props.onApply(value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onCancel();
        }
      }}
    >
      <label className="bubble-link-label">
        <span>Link address</span>
        <input
          ref={field}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={props.refusal !== null}
          aria-describedby={props.refusal === null ? undefined : LINK_ERROR_ID}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button type="submit" className="bubble-text-button">
        Apply
      </button>
      {props.link !== null ? (
        <button type="button" className="bubble-text-button" onClick={() => props.onApply('')}>
          Remove link
        </button>
      ) : null}
      <button type="button" className="bubble-text-button" onClick={props.onCancel}>
        Cancel
      </button>
      {props.refusal === null ? null : (
        <p id={LINK_ERROR_ID} className="bubble-link-error" role="alert">
          {props.refusal}
        </p>
      )}
    </form>
  );
}
