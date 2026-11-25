import { useSearchParams } from 'react-router';
import { useApi } from '../../api/context';
import { useApiQuery } from '../../api/query';
import { useImportState } from '../../import/api';
import { Button } from '../../ui/primitives';
import NotFoundScreen from '../notfound';
import { ImportForm } from './ImportForm';
import { Progress } from './Progress';
import './import.css';

/** The import of a zip into a collection (R11.3). Only for people who can write: a viewer gets the not-found screen, and nothing about imports is asked of the API before it is known who they are. */
export default function ImportScreen() {
  const api = useApi();
  const me = useApiQuery<{ role: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  if (me.isError && me.data === undefined) {
    return (
      <p role="alert">
        Couldn&apos;t check who you are. <Button onClick={() => void me.refetch()}>Try again</Button>
      </p>
    );
  }
  if (me.data === undefined) return <p>Loading</p>;
  if (me.data.role === 'viewer') return <NotFoundScreen />;
  return <Importing />;
}

function Importing() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  // The import is in the address, so that a reload goes on watching it.
  const id = params.get('import');
  const state = useImportState(api, id);
  return (
    <section aria-labelledby="screen-title" className="import-screen">
      <h1 id="screen-title">Import</h1>
      {id === null ? (
        <ImportForm onStarted={(started) => { setParams({ import: started }); }} />
      ) : state.data !== undefined ? (
        <>
          <Progress state={state.data} />
          {state.data.status === 'running' || state.data.status === 'created' || state.data.status === 'uploaded' ? null : (
            <Button onClick={() => { setParams({}); }}>Import another file</Button>
          )}
        </>
      ) : state.isError ? (
        <p role="alert">
          That import can&rsquo;t be read. <Button onClick={() => { setParams({}); }}>Start again</Button>
        </p>
      ) : (
        <p role="status">Loading…</p>
      )}
    </section>
  );
}
