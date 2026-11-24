import { useApi } from '../../api/context';
import { TrashScreen } from './TrashScreen';

/** The route `/trash`. */
export default function Screen() {
  return <TrashScreen api={useApi()} />;
}
