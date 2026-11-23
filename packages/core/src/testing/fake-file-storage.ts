import { FileStorageError, type FileStorage } from '../ports/file-storage.js';

const notYet = (): never => {
  throw new FileStorageError('unsupported', 'the in-memory file store arrives with the next change');
};

/** In-memory FileStorage for tests. The methods arrive with the fake itself (M5-T01, second pull request). */
export class FakeFileStorage implements FileStorage {
  head: FileStorage['head'] = notYet;
  get: FileStorage['get'] = notYet;
  put: FileStorage['put'] = notYet;
  delete: FileStorage['delete'] = notYet;
  list: FileStorage['list'] = notYet;
  signUpload: FileStorage['signUpload'] = notYet;
  signDownload: FileStorage['signDownload'] = notYet;
}
