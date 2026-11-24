import { useQuery } from '@tanstack/react-query';
import type { components } from '@tektum/grimoire-api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { type ApiLike, NO_CACHE, queryKey } from '../../api/query';
import { realEngine } from '../page/engine';
import { HttpError } from '../../tree/useTree';
import { Button } from '../../ui/primitives';
import NotFoundScreen from '../notfound';
import { DiffView } from './DiffView';
import './history.css';
import type { HistoryPage } from './RevisionList';
import { RevisionBody, type MountReadOnly } from './RevisionBody';
import { RevisionMeta } from './RevisionMeta';

type WithMarkdown = Readonly<components['schemas']['RevisionWithMarkdown']>;
type Tab = 'text' | 'changes';

/**
 * One version (R9.4): its Markdown as the page would show it, and the line diff against the page as it is now. Neither text is kept in the query cache
 * (R11.5). The diff reads from the page to the version, so it shows what restoring would remove and add.
 */
export function RevisionView({ api, page, slug, revisionId, mount = realEngine.mountReadOnly }: {
  readonly api: ApiLike;
  readonly page: HistoryPage;
  readonly slug: string;
  readonly revisionId: string;
  readonly mount?: MountReadOnly;
}) {
  const [tab, setTab] = useState<Tab>('text');
  const revision = useQuery<WithMarkdown, HttpError>({
    ...NO_CACHE,
    queryKey: queryKey('GET', '/v1/pages/{id}/revisions/{rid}', { params: { path: { id: page.id, rid: revisionId } } }),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/pages/{id}/revisions/{rid}' as never, { params: { path: { id: page.id, rid: revisionId } }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as WithMarkdown;
    },
  });
  const current = useQuery<{ markdown: string; stale: boolean }, HttpError>({
    ...NO_CACHE,
    queryKey: queryKey('GET', '/v1/pages/{id}/markdown', { params: { path: { id: page.id } } }),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/pages/{id}/markdown' as never, { params: { path: { id: page.id } }, parseAs: 'text', signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      if (data !== undefined && typeof data !== 'string') throw new HttpError(502); // not the text the route promises: a failed comparison, never an empty page
      return { markdown: data ?? '', stale: response.headers.get('x-grimoire-markdown-stale') === 'true' };
    },
  });
  if (revision.error?.status === 404 || revision.error?.status === 403) return <NotFoundScreen />;
  const back = (
    <p>
      <Link to={`/p/${slug}/history`}>All versions</Link>
    </p>
  );
  if (revision.isError) {
    return (
      <section aria-labelledby="screen-title" className="history-screen">
        {back}
        <h1 id="screen-title">Version</h1>
        <p role="alert">
          Couldn&apos;t load this version. <Button onClick={() => void revision.refetch()}>Try again</Button>
        </p>
      </section>
    );
  }
  if (revision.data === undefined) {
    return (
      <section aria-labelledby="screen-title" className="history-screen">
        {back}
        <h1 id="screen-title">Version</h1>
        <p>Loading</p>
      </section>
    );
  }
  const data = revision.data;
  return (
    <section aria-labelledby="screen-title" className="history-screen">
      {back}
      <h1 id="screen-title">{data.title}</h1>
      <RevisionMeta revision={data} />
      <div role="tablist" aria-label="View" className="history-tabs">
        <Button role="tab" id="tab-text" aria-selected={tab === 'text'} aria-controls="panel-text" onClick={() => { setTab('text'); }}>Text</Button>
        <Button role="tab" id="tab-changes" aria-selected={tab === 'changes'} aria-controls="panel-changes" onClick={() => { setTab('changes'); }}>Changes</Button>
      </div>
      {tab === 'text' ? (
        <div role="tabpanel" id="panel-text" aria-labelledby="tab-text">
          <RevisionBody markdown={data.markdown} mount={mount} />
        </div>
      ) : (
        <div role="tabpanel" id="panel-changes" aria-labelledby="tab-changes">
          {current.isError ? (
            <p role="alert">
              Couldn&apos;t compare with the page right now. <Button onClick={() => void current.refetch()}>Try again</Button>
            </p>
          ) : current.data === undefined ? (
            <p>Loading</p>
          ) : current.data.stale ? (
            <p role="status">
              The page is still being saved, so it can&apos;t be compared with this version yet. <Button onClick={() => void current.refetch()}>Try again</Button>
            </p>
          ) : (
            <>
              <p>Restoring this version would remove the lines marked Removed and add the lines marked Added.</p>
              <DiffView from={current.data.markdown} to={data.markdown} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
