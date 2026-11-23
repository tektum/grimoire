import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';

interface SdkErrorShape {
  readonly name?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

/**
 * Maps what the SDK throws to the port's error kinds: a missing key, a range outside the object and a failed
 * precondition each have a kind; everything else (network, timeout, 5xx, refused credentials, missing bucket) is
 * `unavailable`, because the caller can do nothing about it per request.
 */
export function mapError(error: unknown): FileStorageError {
  if (error instanceof FileStorageError) return error;
  const shape = (typeof error === 'object' && error !== null ? error : {}) as SdkErrorShape;
  const name = typeof shape.name === 'string' ? shape.name : '';
  const status = shape.$metadata?.httpStatusCode;
  if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) {
    return new FileStorageError('not-found', 'the object does not exist');
  }
  if (name === 'InvalidRange' || status === 416) {
    return new FileStorageError('range-not-satisfiable', 'the range lies outside the object');
  }
  if (name === 'PreconditionFailed' || status === 412) {
    return new FileStorageError('already-exists', 'the object exists and the put is create-only');
  }
  return new FileStorageError(
    'unavailable',
    `the file store did not answer the request${status ? ` (${status})` : ''}`,
  );
}
