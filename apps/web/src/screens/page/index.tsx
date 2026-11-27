import { useEffect } from 'react';
import { useParams } from 'react-router';
import { useApiQuery } from '../../api/query';
import { useSession } from '../../auth/session';
import { removeRecent } from '../../storage/recent';
import { urlIdOf } from '../../app/routes';
import { PageNotFound } from './PageNotFound';
import { PageView } from './PageView';
import { usePage } from './usePage';

export default function PageScreen() {
  const { slug = '' } = useParams();
  const urlId = urlIdOf(slug);
  const result = usePage(urlId);
  // A page that is not there for this person (removed, or no longer theirs to read) is taken out of their Recent, so that the palette does not lead to a dead end.
  const session = useSession();
  const me = useApiQuery<{ id: string }>(session?.api ?? (null as never), '/v1/me', undefined, { enabled: session !== null });
  // Only on a completed, current answer: a cached 'missing' whose re-read failed (a 500, the network) says nothing about access now.
  const missing = result.data?.kind === 'missing' && result.isSuccess && !result.isFetching;
  const meId = me.data?.id;
  useEffect(() => {
    if (missing && meId !== undefined) removeRecent(meId, urlId);
  }, [missing, meId, urlId]);
  if (result.isPending) return <p role="status">Loading…</p>;
  // A failed re-read of a page that is open keeps it open (its permission is read again when its document is replaced). A failed read of anything else, nothing yet or an earlier 'not found', is not a 'not found': it says the page cannot be opened.
  if (result.isError && (result.data === undefined || result.data.kind === 'missing')) return <p role="alert">This page can&rsquo;t be opened right now. Reload to try again.</p>;
  if (result.data.kind === 'missing') return <PageNotFound />;
  return <PageView key={result.data.page.id} page={result.data.page} onReplaced={result.refetch} />;
}
