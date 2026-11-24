import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useApi } from '../../api/context';
import { createClientStorage } from '../../storage';
import { CollectionsScreen } from './CollectionsScreen';

/** The route `/c/:collectionId`. */
export default function Screen() {
  const api = useApi();
  const { collectionId } = useParams();
  const storage = useMemo(() => createClientStorage(), []);
  return <CollectionsScreen api={api} collectionId={collectionId ?? ''} storage={storage} />;
}
