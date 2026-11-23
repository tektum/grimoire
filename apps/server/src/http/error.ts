import { HTTPException } from 'hono/http-exception';

/** Every error code of the API and the HTTP status it answers with. */
export const ERROR_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  account_suspended: 403,
  not_allowed: 403,
  not_found: 404,
  conflict: 409,
  would_create_cycle: 409,
  too_deep: 409,
  collection_full: 409,
  collection_deleted: 409,
  last_admin: 409,
  name_taken: 409,
  save_failed: 409,
  markdown_stale: 409,
  upload_missing: 409,
  size_mismatch: 409,
  too_large: 413,
  invalid: 422,
  type_not_allowed: 422,
  type_mismatch: 422,
  client_too_old: 426,
  rate_limited: 429,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export interface ErrorEnvelope { readonly error: { readonly code: ErrorCode; readonly message: string } }

/** One fixed sentence per code. A message never carries request data, a title, an email or a stack. */
const MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'Sign in to continue.',
  forbidden: 'You are not allowed to do this.',
  account_suspended: 'This account is suspended.',
  not_allowed: 'Sign-in is not allowed for this account.',
  not_found: 'Not found.',
  conflict: 'The request conflicts with the current state.',
  would_create_cycle: 'A page cannot be moved under itself.',
  too_deep: 'The page tree would be too deep.',
  collection_full: 'The collection is full.',
  collection_deleted: 'The collection is deleted.',
  last_admin: 'The last administrator cannot be removed.',
  name_taken: 'That name is already taken.',
  save_failed: 'The page could not be saved.',
  markdown_stale: 'The saved Markdown is older than the page.',
  upload_missing: 'The upload was not found.',
  size_mismatch: 'The uploaded size does not match.',
  too_large: 'The request is too large.',
  invalid: 'The request is not valid.',
  type_not_allowed: 'This file type is not allowed.',
  type_mismatch: 'The file does not match its declared type.',
  client_too_old: 'This client is too old. Update it to continue.',
  rate_limited: 'Too many requests. Try again later.',
  unavailable: 'The service is unavailable. Try again later.',
};

export function errorBody(code: ErrorCode, message: string = MESSAGE[code]): ErrorEnvelope {
  return { error: { code, message } };
}

export function errorResponse(code: ErrorCode, message?: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(errorBody(code, message)), {
    status: ERROR_STATUS[code],
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An error this API raised on purpose; anything else that reaches the error handler is an unexpected failure. */
export class ApiError extends HTTPException {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string, headers?: Record<string, string>) {
    super(ERROR_STATUS[code], { res: errorResponse(code, message, headers) });
    this.code = code;
  }
}

/** Raises the envelope for `code`; the error handler turns it into the response. */
export function fail(code: ErrorCode, message?: string, headers?: Record<string, string>): never {
  throw new ApiError(code, message, headers);
}
