import { messageFor } from '../../api/messages';
import type { ApiLike } from '../../api/query';

export const TOO_MANY_UPLOADS = 'Too many uploads at once. Wait a moment.';

export interface Attachment {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly markdownPath: string;
  readonly pageId: string;
}

export type UploadResult = { readonly ok: true; readonly attachment: Attachment } | { readonly ok: false; readonly message: string };

export interface UploadDeps {
  /** The client for the three calls to the server; a quiet one, so that a refusal is told once, here, in these words. */
  readonly api: ApiLike;
  /** `fetch` for the one request to the file store (no bearer token, no cookies). */
  readonly put: typeof fetch;
  readonly pageId: string;
}

interface Answer {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response: Response;
}

const codeOf = (error: unknown): string | undefined => (error as { error?: { code?: string } } | undefined)?.error?.code;
const refused = (answer: Answer): UploadResult => ({ ok: false, message: answer.response.status === 429 ? TOO_MANY_UPLOADS : messageFor(codeOf(answer.error)) });
const DID_NOT_FINISH = messageFor('upload_missing');

/**
 * The M5 sequence for one file: create (the server says where to PUT and with which headers), PUT the bytes with exactly those headers, complete. It never throws: a
 * refusal or a failure is a plain message for the person, and the file is not in the document.
 */
export async function uploadAttachment(deps: UploadDeps, file: File): Promise<UploadResult> {
  try {
    const body = { pageId: deps.pageId, fileName: file.name === '' ? 'file' : file.name, contentType: file.type === '' ? 'application/octet-stream' : file.type, size: file.size };
    const create = (await deps.api.POST('/v1/attachments' as never, { body } as never)) as Answer;
    if (!create.response.ok) return refused(create);
    const made = create.data as { id: string; upload: { url: string; headers: Record<string, string> } };
    let stored: Response;
    try {
      stored = await deps.put(made.upload.url, { method: 'PUT', headers: made.upload.headers, body: file, credentials: 'omit' });
    } catch {
      return { ok: false, message: DID_NOT_FINISH };
    }
    if (!stored.ok) return { ok: false, message: DID_NOT_FINISH };
    const complete = (await deps.api.POST('/v1/attachments/{id}/complete' as never, { params: { path: { id: made.id } } } as never)) as Answer;
    if (!complete.response.ok) return refused(complete);
    return { ok: true, attachment: complete.data as Attachment };
  } catch {
    return { ok: false, message: messageFor(undefined) };
  }
}
