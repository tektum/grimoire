import type { ApiClient, components } from '@tektum/grimoire-api-client';
import { messageFor } from '../../api/messages';
import { tooLargeMessage, tooManyMessage, type UploadLimits } from './limits';

/** What the server says about a stored upload (`POST /v1/attachments/{id}/complete`). */
export type Attachment = components['schemas']['Attachment'];

export type UploadResult = { readonly ok: true; readonly attachment: Attachment } | { readonly ok: false; readonly message: string };

export interface UploadDeps {
  /** The client for the three calls to the server; a quiet one, so that a refusal is told once, here, in these words. */
  readonly api: ApiClient;
  /** `fetch` for the one request to the file store (no bearer token, no cookies). */
  readonly put: typeof fetch;
  readonly pageId: string;
  /** What the server announced about sizes and counts, read when a refusal needs it (it may arrive after the editor). */
  readonly limits?: () => Promise<UploadLimits | undefined>;
}

/** The error body of the API (`{ error: { code, message } }`), as every refusal of these routes carries it. */
type ApiError = { readonly error?: { readonly code?: string } } | undefined;
const codeOf = (error: ApiError): string | undefined => error?.error?.code;
const refused = async (error: ApiError, response: Response, asked: (() => Promise<UploadLimits | undefined>) | undefined): Promise<UploadResult> => {
  const code = codeOf(error);
  const limits = response.status === 429 || code === 'too_large' ? await asked?.() : undefined; // the limits are asked for only when a message says one
  if (response.status === 429) return { ok: false, message: tooManyMessage(limits) };
  return { ok: false, message: code === 'too_large' ? tooLargeMessage(limits) : messageFor(code) };
};
const DID_NOT_FINISH = messageFor('upload_missing');

/**
 * The M5 sequence for one file: create (the server says where to PUT and with which headers), PUT the bytes with exactly those headers, complete. It never throws: a
 * refusal or a failure is a plain message for the person, and the file is not in the document.
 */
export async function uploadAttachment(deps: UploadDeps, file: File): Promise<UploadResult> {
  try {
    const body = { pageId: deps.pageId, fileName: file.name === '' ? 'file' : file.name, contentType: file.type === '' ? 'application/octet-stream' : file.type, size: file.size };
    const create = await deps.api.POST('/v1/attachments', { body });
    if (create.data === undefined) return refused(create.error, create.response, deps.limits);
    const { id, upload } = create.data;
    let stored: Response;
    try {
      stored = await deps.put(upload.url, { method: 'PUT', headers: upload.headers, body: file, credentials: 'omit' });
    } catch {
      return { ok: false, message: DID_NOT_FINISH };
    }
    if (!stored.ok) return { ok: false, message: DID_NOT_FINISH };
    const complete = await deps.api.POST('/v1/attachments/{id}/complete', { params: { path: { id } } });
    if (complete.data === undefined) return refused(complete.error, complete.response, deps.limits);
    return { ok: true, attachment: complete.data };
  } catch {
    return { ok: false, message: messageFor(undefined) };
  }
}
