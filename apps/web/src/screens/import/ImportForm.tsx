import { useState } from 'react';
import { useApi } from '../../api/context';
import { createImport, startImport, uploadZip } from '../../import/api';
import { useCollections } from '../collections/useCollections';
import { Button } from '../../ui/primitives';
import { refusal } from './messages';

/** R10.14: said before the file is chosen, because it is the one thing about the import the person cannot see afterwards. */
export const DUPLICATE_WARNING = 'Running this import again creates a second copy of every page.';

type Phase = 'idle' | 'creating' | 'uploading' | 'starting';
const PHASE_TEXT: Record<Exclude<Phase, 'idle'>, string> = { creating: 'Creating the import…', uploading: 'Uploading the file…', starting: 'Starting…' };

/** Choose a zip and a collection, then make the import, send the file and start it (R6.39, R6.40). `onStarted` gets the id of the import that is running. */
export function ImportForm({ onStarted, send }: { readonly onStarted: (id: string) => void; readonly send?: typeof fetch }) {
  const api = useApi();
  const collections = useCollections(api);
  const writable = (collections.data ?? []).filter((c) => c.myPermission === 'read-write');
  const [collectionId, setCollectionId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  const target = collectionId === '' ? writable[0]?.id : collectionId;

  const begin = async (): Promise<void> => {
    if (file === null || target === undefined) return;
    setProblem(null);
    try {
      setPhase('creating');
      const created = await createImport(api, { collectionId: target, fileName: file.name, size: file.size });
      setPhase('uploading');
      await uploadZip(created.upload, file, send);
      setPhase('starting');
      await startImport(api, created.id);
      onStarted(created.id);
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
      <label htmlFor="import-collection">Into the collection</label>
      <select id="import-collection" value={target ?? ''} disabled={busy || writable.length === 0} onChange={(event) => { setCollectionId(event.target.value); }}>
        {writable.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <label htmlFor="import-file">Zip file</label>
      <input id="import-file" type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); }} />
      {problem === null ? null : <p role="alert">{problem}</p>}
      {busy ? <p role="status">{PHASE_TEXT[phase as Exclude<Phase, 'idle'>]}</p> : null}
      <Button type="submit" variant="primary" disabled={busy || file === null || target === undefined}>
        Import
      </Button>
    </form>
  );
}
