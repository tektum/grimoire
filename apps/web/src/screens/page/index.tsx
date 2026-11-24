import { useParams } from 'react-router';
import { urlIdOf } from '../../app/routes';
import { PageView } from './PageView';
import { usePage } from './usePage';

export default function PageScreen() {
  const { slug = '' } = useParams();
  const result = usePage(urlIdOf(slug));
  if (result.isPending) return <p role="status">Loading…</p>;
  if (result.isError) return <p role="alert">This page can&rsquo;t be opened right now. Reload to try again.</p>;
  if (result.data.kind === 'missing')
    return (
      <section aria-labelledby="screen-title">
        <h1 id="screen-title">Page not found</h1>
        <p>This page does not exist, or you do not have access to it.</p>
      </section>
    );
  return <PageView key={result.data.page.id} page={result.data.page} onReplaced={result.refetch} />;
}
