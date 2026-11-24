import { useParams } from 'react-router';
import { urlIdOf } from '../../app/routes';
import { PageNotFound } from './PageNotFound';
import { PageView } from './PageView';
import { usePage } from './usePage';

export default function PageScreen() {
  const { slug = '' } = useParams();
  const result = usePage(urlIdOf(slug));
  if (result.isPending) return <p role="status">Loading…</p>;
  // A failed re-read of a page that is open keeps it open (its permission is read again when its document is replaced). A failed read of anything else, nothing yet or an earlier 'not found', is not a 'not found': it says the page cannot be opened.
  if (result.isError && (result.data === undefined || result.data.kind === 'missing')) return <p role="alert">This page can&rsquo;t be opened right now. Reload to try again.</p>;
  if (result.data.kind === 'missing') return <PageNotFound />;
  return <PageView key={result.data.page.id} page={result.data.page} onReplaced={result.refetch} />;
}
