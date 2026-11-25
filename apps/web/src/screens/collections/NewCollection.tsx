import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type ApiLike, queryKey, useApiQuery } from '../../api/query';
import { useQuietApi } from '../../import/api';
import { Button } from '../../ui/primitives';
import NotFoundScreen from '../notfound';
import { LIST_PATH } from './useCollections';
import './new-collection.css';

const NAME_MAX = 100;
/** What everyone in the workspace may do in a collection without an entry of their own (R6.13). Nothing is sent for "only people you give access to". */
const ACCESS = [
  { value: 'read_write', label: 'Everyone in the workspace can edit' },
  { value: 'read', label: 'Everyone in the workspace can read' },
  { value: 'none', label: 'Only people you give access to' },
] as const;
type Access = (typeof ACCESS)[number]['value'];

const codeOf = (error: unknown): string | undefined => (error as { error?: { code?: string } } | undefined)?.error?.code;

/** Plain words for a refusal; the reason is the API's code where it gives one, the status otherwise. */
function refusal(status: number, code: string | undefined): string {
  if (code === 'name_taken') return 'A collection with that name already exists.';
  if (status === 422) return 'That name can’t be used. Use 1 to 100 characters.';
  if (status === 403) return 'Only administrators can create collections.';
  if (status === 429) return 'Too many requests. Try again in a moment.';
  return 'The collection could not be created. Try again.';
}

/** `/collections/new` (R11.3): an administrator names a collection and says what everyone may do in it, and is taken to it, where the new page flow already works. Anyone else gets the not-found screen. */
export default function Screen() {
  return <NewCollection api={useQuietApi()} />;
}

export function NewCollection({ api }: { readonly api: ApiLike }) {
  const me = useApiQuery<{ role: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  if (me.isError && me.data === undefined) {
    return (
      <p role="alert">
        Couldn&apos;t check who you are. <Button onClick={() => void me.refetch()}>Try again</Button>
      </p>
    );
  }
  if (me.data === undefined) return <p>Loading</p>;
  return me.data.role === 'admin' ? <Form api={api} /> : <NotFoundScreen />;
}

function Form({ api }: { readonly api: ApiLike }) {
  const client = useQueryClient();
  const go = useNavigate();
  const nameField = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<Access>('read_write');
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => nameField.current?.focus(), []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (sending) return;
    const wanted = name.trim();
    if (wanted === '') return setProblem('Give the collection a name.');
    setProblem(null);
    setSending(true);
    try {
      const { data, error, response } = await api.POST(LIST_PATH as never, { body: { name: wanted, ...(access === 'none' ? {} : { defaultPermission: access }) } } as never);
      if (!response.ok) return setProblem(refusal(response.status, codeOf(error)));
      await client.invalidateQueries({ queryKey: queryKey('GET', LIST_PATH, undefined) });
      go(`/c/${(data as { id: string }).id}`);
    } catch {
      setProblem(refusal(0, undefined)); // the network failed
    } finally {
      setSending(false);
    }
  };

  return (
    <section aria-labelledby="new-collection-title" className="new-collection">
      <h1 id="new-collection-title">New collection</h1>
      <form noValidate onSubmit={(event) => void submit(event)} className="new-collection-form">
        <label className="new-collection-field">
          Name
          <input ref={nameField} type="text" value={name} maxLength={NAME_MAX} autoComplete="off" aria-invalid={problem === 'Give the collection a name.'} onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset>
          <legend>Who can open it</legend>
          {ACCESS.map((option) => (
            <label key={option.value} className="new-collection-choice">
              <input type="radio" name="access" value={option.value} checked={access === option.value} onChange={() => setAccess(option.value)} />
              {option.label}
            </label>
          ))}
          <p className="new-collection-note">Administrators can always open it. You can change this later under Manage access.</p>
        </fieldset>
        {problem !== null && <p role="alert">{problem}</p>}
        <div className="new-collection-actions">
          <Button variant="primary" type="submit" disabled={sending}>
            Create collection
          </Button>
          <Link to="/">Cancel</Link>
        </div>
      </form>
    </section>
  );
}
