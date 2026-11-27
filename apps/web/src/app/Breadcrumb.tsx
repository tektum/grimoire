import { Link } from 'react-router';
import type { ApiLike } from '../api/query';
import { useCollections } from '../screens/collections/useCollections';
import { ancestry, pagePath } from '../tree/model';
import { useOpenCollection } from '../tree/ContentsPanel';
import { useCollectionTree } from '../tree/useTree';
import { useSession } from '../auth/session';

/** Where the open page is: its collection, the pages above it and itself, last and not a link. Nothing outside a collection or without a session. */
export function Breadcrumb() {
  const session = useSession();
  return session === null ? null : <Trail api={session.api} />;
}

function Trail({ api }: { readonly api: ApiLike }) {
  const { collectionId, urlId } = useOpenCollection(api);
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const name = collections.data?.find((c) => c.id === collectionId)?.name;
  if (collectionId === undefined || name === undefined) return null;
  const path = urlId === undefined || tree.data === undefined ? [] : ancestry(tree.data, urlId);
  const label = (title: string): string => (title === '' ? 'Untitled' : title);
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <span>{path.length === 0 ? <span aria-current="page">{name}</span> : <Link to={`/c/${collectionId}`}>{name}</Link>}</span>
      {path.map((p, i) => (
        <span key={p.id}>{i === path.length - 1 ? <span aria-current="page">{label(p.title)}</span> : <Link to={pagePath(p.title, p.urlId)}>{label(p.title)}</Link>}</span>
      ))}
    </nav>
  );
}
