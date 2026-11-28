import { useEffect } from 'react';
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
export function Breadcrumb({ onParent }: { readonly onParent?: (has: boolean) => void }) {
  const session = useSession();
  return session === null ? null : <Trail api={session.api} onParent={onParent} />;
}

function Trail({ api, onParent }: { readonly api: ApiLike; readonly onParent: ((has: boolean) => void) | undefined }) {
  const { collectionId, urlId } = useOpenCollection(api);
  const inCollection = useMatch('/c/:collectionId') !== null;
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const name = collections.data?.find((c) => c.id === collectionId)?.name;
  // The remembered collection also answers on other screens (search, trash): there is no trail there.
  const showing = collectionId !== undefined && name !== undefined && (inCollection || urlId !== undefined);
  const path = !showing || urlId === undefined || tree.data === undefined ? [] : ancestry(tree.data, urlId);
  // Whether there is a parent to show on a phone (the bar then has it in place of the brand): said to the shell, which knows nothing of the trail.
  const hasParent = path.length > 0;
  useEffect(() => {
    onParent?.(hasParent);
    return () => { onParent?.(false); };
  }, [onParent, hasParent]);
  if (!showing) return null;
  const label = (title: string): string => (title === '' ? 'Untitled' : title);
  const last = path.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol>
        <li>{inCollection ? <span aria-current="page" title={name}>{name}</span> : <Link to={`/c/${collectionId}`} title={name}><span>{name}</span></Link>}</li>
        {last > 0 ? <li className="breadcrumb-fold" aria-hidden="true">{'\u2026'}</li> : null}
        {path.map((p, i) => (
          <li key={p.id} className={i < last ? 'breadcrumb-middle' : undefined}>
            {i === last ? <span aria-current="page" title={label(p.title)}>{label(p.title)}</span> : <Link to={pagePath(p.title, p.urlId)} title={label(p.title)}><span>{label(p.title)}</span></Link>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
