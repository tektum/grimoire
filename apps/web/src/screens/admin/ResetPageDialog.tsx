import type { components } from '@tektum/grimoire-api-client';
import { type RefObject, useRef, useState } from 'react';
import type { ApiLike } from '../../api/query';
import { Button, Confirm, Modal } from '../../ui/primitives';
import './admin.css';

type Reset = Readonly<components['schemas']['PageStateReset']>;
type View = 'ask' | 'stale' | 'done';

/**
 * The administrators' reset of a page's saved state (R6.21, R3.20), for the page screen to open. It asks first, naming the page, with an optional replacement
 * Markdown. A saved text older than the state (409 `markdown_stale`) is a second question: the newest edits would be lost. The call is made once per confirmation.
 */
export function ResetPageDialog({ api, page, open, onOpenChange, returnFocus }: {
  /** Where the focus goes when the dialog closes. */
  readonly returnFocus?: RefObject<HTMLElement | null>;
  readonly api: ApiLike;
  readonly page: { readonly id: string; readonly title: string };
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState<View>('ask');
  const [markdown, setMarkdown] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const sending = useRef(false);
  const generation = useRef(0); // each closing starts a new one: an answer to a call made before it is not shown

  const close = (): void => {
    generation.current += 1;
    setView('ask');
    setMarkdown('');
    setProblem(null);
    setOlder(false);
    onOpenChange(false);
  };

  /** One call. `confirmStale` is sent only after the second question has been answered yes. */
  const send = async (confirmStale: boolean): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    const mine = generation.current;
    setBusy(true);
    setProblem(null);
    try {
      // One test of emptiness for the request and for the button's look: whitespace alone is no replacement text.
      const replacement = markdown.trim() === '' ? {} : { markdown };
      const body = { ...replacement, ...(confirmStale ? { confirmStale: true } : {}) };
      const { data, error, response } = (await api.POST('/v1/pages/{id}/reset-state' as never, { params: { path: { id: page.id } }, body } as never)) as {
        data?: Reset;
        error?: { error?: { code?: string; message?: string } };
        response: Response;
      };
      if (mine !== generation.current) return; // the dialog was closed meanwhile
      if (response.ok && data !== undefined) {
        setOlder(data.markdownStale);
        setView('done');
      } else if (response.status === 409 && error?.error?.code === 'markdown_stale') {
        setView('stale');
      } else {
        setView('ask');
        setProblem(response.status === 422 && error?.error?.message !== undefined ? error.error.message : "The state wasn't reset. Try again.");
      }
    } catch {
      if (mine !== generation.current) return;
      setView('ask');
      setProblem("The state wasn't reset. Try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <Modal title={`Reset the saved state of ${page.title}?`} open={open && view !== 'stale'} {...(returnFocus === undefined ? {} : { returnFocus })} onOpenChange={(isOpen) => { if (!isOpen) close(); }}>
        {view === 'done' ? (
          <p role="status">
            The state of {page.title} was reset.{older ? ' Its saved text was older than its state, so the newest edits were not kept.' : ''}
          </p>
        ) : (
          <>
            <p>The page is rebuilt from its saved Markdown. People who have it open are disconnected and reconnect.</p>
            <label className="admin-field admin-block">
              <span>Replacement Markdown (optional)</span>
              <textarea aria-label="Replacement Markdown (optional)" rows={8} value={markdown} onChange={(e) => { setMarkdown(e.target.value); }} />
            </label>
            {problem !== null && <p role="alert">{problem}</p>}
            {/* With replacement text the reset loses what the page holds (destructive); with none it only rebuilds the saved text, so it keeps the accent. */}
            <Button variant={markdown.trim() === '' ? 'primary' : 'destructive'} disabled={busy} onClick={() => void send(false)}>Reset state</Button>
          </>
        )}
      </Modal>
      <Confirm
        title="The saved text is older than the page"
        description={`The saved Markdown of ${page.title} is older than its newest edits. Resetting now means the newest edits would be lost, and the page keeps only its saved Markdown.`}
        confirmLabel="Reset anyway"
        open={open && view === 'stale'}
        onOpenChange={(isOpen) => { if (!isOpen && !sending.current) setView('ask'); }}
        onConfirm={() => { void send(true); }}
      />
    </>
  );
}
