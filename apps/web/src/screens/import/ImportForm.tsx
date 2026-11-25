import { useRef, useState } from 'react';
import { createImport, ImportError, startImport, uploadZip, useQuietApi } from '../../import/api';
import type { CreatedImport } from '../../import/types';
import { useCollections } from '../collections/useCollections';
import { Button } from '../../ui/primitives';
import { refusal } from './messages';

/** R10.14: said before the file is chosen, because it is the one thing about the import the person cannot see afterwards. */
export const DUPLICATE_WARNING = 'Running this import again creates a second copy of every page.';

type Phase = 'idle' | 'creating' | 'uploading' | 'starting';
const PHASE_TEXT: Record<Exclude<Phase, 'idle'>, string> = { creating: 'Creating the import…', uploading: 'Uploading the file…', starting: 'Starting…' };

/** Choose a zip and a collection, then make the import, send the file and start it (R6.39, R6.40). `onStarted` gets the id of the import that is running. */
export function ImportForm({ onStarted, send }: { readonly onStarted: (id: string) => void; readonly send?: typeof fetch }) {
  const api = useQuietApi();
  const collections = useCollections(api);
  const writable = (collections.data ?? []).filter((c) => c.myPermission === 'read-write');
  const [collectionId, setCollectionId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  // The import made for this file and collection, so that a try again after a refusal goes on with it and does not make a second one that the first would leave in `created`.
  const made = useRef<{ key: string; created: CreatedImport; uploaded: boolean } | null>(null);
  const target = collectionId === '' ? writable[0]?.id : collectionId;

  const begin = async (): Promise<void> => {
    if (file === null || target === undefined) return;
    setProblem(null);
    try {
      const key = `${target}|${file.name}|${String(file.size)}|${String(file.lastModified)}`;
      if (made.current?.key !== key) {
        setPhase('creating');
        made.current = { key, created: await createImport(api, { collectionId: target, fileName: file.name, size: file.size }), uploaded: false };
      }
      const job = made.current;
      if (!job.uploaded) {
        setPhase('uploading');
        try {
          await uploadZip(job.created.upload, file, send);
        } catch (error) {
          // A refused PUT means the address is no good any more (it is signed for a time): the next try makes a new import.
          if (error instanceof ImportError && error.status === 403) made.current = null;
          throw error;
        }
        job.uploaded = true;
      }
      setPhase('starting');
      try {
        await startImport(api, job.created.id);
      } catch (error) {
        if (error instanceof ImportError && error.code === 'upload_missing') job.uploaded = false; // it did not arrive: send it again, to the same import
        if (error instanceof ImportError && error.code === 'already_started') made.current = null;
        throw error;
      }
      made.current = null;
      onStarted(job.created.id);
    } catch (error) {
      setProblem(refusal(error));
      setPhase('idle');
    }
  };

  const busy = phase !== 'idle';
  return (
    <form
      className="import-form"
      onSubmit={(event) => {
        event.preventDefault();
        void begin();
      }}
    >
      <p className="import-warning" role="note">
        {DUPLICATE_WARNING}
      </p>
      {collections.isError ? (
        <p role="alert">
          Couldn&rsquo;t load your collections. <Button onClick={() => void collections.refetch()}>Try again</Button>
        </p>
      ) : null}
      <label htmlFor="import-collection">Into the collection</label>
      <select
        id="import-collection"
        value={target ?? ''}
        disabled={busy || writable.length === 0}
        onChange={(event) => {
          setCollectionId(event.target.value);
        }}
      >
        {writable.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {/* A real file input (the keyboard and a screen reader meet it as one), drawn as the app's button: the input is hidden by position and size, not by display, so it keeps the focus, and the label shows it. */}
      <div className="import-file-row">
        <label className="button import-file-button" data-disabled={busy ? 'true' : undefined}>
          Choose a .zip file
          <input
            className="import-file-input"
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            aria-describedby="import-file-name"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
            }}
          />
        </label>
        <span id="import-file-name" className="import-file-name">
          {file === null ? 'No file chosen' : file.name}
        </span>
      </div>
      {problem === null ? null : <p role="alert">{problem}</p>}
      {busy ? <p role="status">{PHASE_TEXT[phase as Exclude<Phase, 'idle'>]}</p> : null}
      <Button type="submit" variant="primary" disabled={busy || file === null || target === undefined}>
        Import
      </Button>
    </form>
  );
}
