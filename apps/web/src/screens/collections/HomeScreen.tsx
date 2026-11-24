import { useMemo } from 'react';
import { useApi } from '../../api/context';
import { createClientStorage } from '../../storage';
import { HomeRedirect } from './HomeRedirect';

/** The route `/`. */
export default function HomeScreen() {
  const api = useApi();
  const storage = useMemo(() => createClientStorage(), []);
  return <HomeRedirect api={api} storage={storage} />;
}
