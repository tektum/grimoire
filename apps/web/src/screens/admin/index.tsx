import { useApi } from '../../api/context';
import { AdminArea } from './AdminArea';

/** The routes under `/admin`. */
export default function Screen() {
  return <AdminArea api={useApi()} />;
}
