import { useParams } from 'react-router';
import { useApi } from '../../api/context';
import { urlIdOf } from '../../app/routes';
import NotFoundScreen from '../notfound';
import { usePage } from '../page/usePage';
import { RevisionList } from './RevisionList';
import { RevisionView } from './RevisionView';

/** The routes `/p/:slug/history` (the versions) and `/p/:slug/history/:revisionId` (one version and its changes). */
export default function Screen() {
  const { slug = '', revisionId } = useParams();
  const api = useApi();
  const result = usePage(urlIdOf(slug));
  if (result.isPending) return <p role="status">Loading…</p>;
  if (result.isError && result.data === undefined) return <p role="alert">This page can&rsquo;t be opened right now. Reload to try again.</p>;
  if (result.data === undefined || result.data.kind === 'missing') return <NotFoundScreen />;
  const page = { id: result.data.page.id, title: result.data.page.title };
  return revisionId === undefined ? <RevisionList api={api} page={page} slug={slug} /> : <RevisionView api={api} page={page} slug={slug} revisionId={revisionId} />;
}
