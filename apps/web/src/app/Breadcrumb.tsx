import { Link, useMatch } from 'react-router';
import type { ApiLike } from '../api/query';
import { useCollections } from '../screens/collections/useCollections';
import { ancestry, pagePath } from '../tree/model';
import { useOpenCollection } from '../tree/ContentsPanel';
import { useCollectionTree } from '../tree/useTree';
import { useSession } from '../auth/session';

/**
 * Where the open page is: its collection, the pages above it and itself, last and not a link. Nothing outside a collection or without a session. Every name is cut with an
 * ellipsis when it does not fit and keeps its full text in a tooltip; on a phone the items between the first and the last fold into one "..." that only the eye sees.
 */
export function Breadcrumb() {
  const session = useSession();
  return session === null ? null : <Trail api={session.api} />;
}

function Trail({ api }: { readonly api: ApiLike }) {
  const { collectionId, urlId } = useOpenCollection(api);
  const inCollection = useMatch('/c/:collectionId') !== null;
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const name = collections.data?.find((c) => c.id === collectionId)?.name;
  // The remembered collection also answers on other screens (search, trash): there is no trail there.
  if (collectionId === undefined || name === undefined || (!inCollection && urlId === undefined)) return null;
  const path = urlId === undefined || tree.data === undefined ? [] : ancestry(tree.data, urlId);
  const label = (title: string): string => (title === '' ? 'Untitled' : title);
  const last = path.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol>
        <li>{inCollection ? <span aria-current="page" title={name}>{name}</span> : <Link to={`/c/${collectionId}`} title={name}>{name}</Link>}</li>
        {last > 0 ? <li className="breadcrumb-fold" aria-hidden="true">{'\u2026'}</li> : null}
        {path.map((p, i) => (
          <li key={p.id} className={i < last ? 'breadcrumb-middle' : undefined}>
            {i === last ? <span aria-current="page" title={label(p.title)}>{label(p.title)}</span> : <Link to={pagePath(p.title, p.urlId)} title={label(p.title)}>{label(p.title)}</Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
