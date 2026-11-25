import { v5 } from 'uuid';
import { attachmentKey, markdownPathFor } from '@tektum/grimoire-core/attachments/key';
import { cleanFileName } from '@tektum/grimoire-core/attachments/file-name';
import { isCheckedType, typeFromFileName, validateAttachmentMeta } from '@tektum/grimoire-core/attachments/validate';
import type { NewReady } from '@tektum/grimoire-core/ports/attachment-repo';
import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import { readEntry } from './read-entry.js';
import type { EntryOpener } from './read-entry.js';
import type { RemoteBudget, RemoteResult } from './remote-images/index.js';
import type { ZipEntry } from './zip-reader.js';

/** The namespace of the ids of imported attachments (a fixed v4, so the same import, page and file always give the same id). */
const NAMESPACE = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

export interface AttachmentSettings {
  /** The largest file an attachment may be (the files setting). */
  readonly maxBytes: number;
  readonly allowedTypes: readonly string[];
  /** The media type the first bytes show, or undefined (the `file-type` signatures). */
  readonly sniff: (bytes: Uint8Array) => Promise<string | undefined>;
}

export interface StageContext {
  readonly files: FileStorage;
  readonly reader: EntryOpener;
  readonly limits: { readonly maxEntryBytes: number; readonly maxRatio: number };
  readonly settings: AttachmentSettings;
  readonly tenantId: string;
  readonly importId: string;
  readonly uploaderId: string;
  readonly now: () => number;
}

/** Why a file cannot be an attachment: the item's end (`skipped` for a refusal of the file, `failed` when it could not be read as it is) and its reason. */
export interface Rejection { readonly status: 'skipped' | 'failed'; readonly reason: 'entry_too_large' | 'type_not_allowed' | 'type_mismatch' | 'size_mismatch' | 'ratio' | 'missing_entry' | 'empty_file'; /** `page`: a property of this page's use of the file (its object), not of the file: it is not remembered for other pages and the file item is not settled by it. */ readonly scope?: 'file' | 'page' }
/** A file stored for a page: the row to write with the page and the address the page's link gets. */
export interface StagedFile { readonly kind: 'ok'; readonly row: Omit<NewReady, 'pageId'>; readonly url: string }
export type Staged = StagedFile | ({ readonly kind: 'rejected' } & Rejection);

/** The id of the attachment a page makes of a file (contracts section 4, stage 4d). */
export const attachmentIdFor = (importId: string, pagePath: string, filePath: string): string => v5(`${importId}:${pagePath}:${filePath}`, NAMESPACE);

/**
 * Judges a file by what is known before reading it (its name's type and its declared size): the same rules, and the same limits, as an upload (M5), so an imported attachment is
 * indistinguishable from an uploaded one. A refusal is a property of the file, not of the page that uses it.
 */
export function judgeFile(ctx: Pick<StageContext, 'limits' | 'settings'>, entry: ZipEntry): { readonly contentType: string } | Rejection {
  const contentType = typeFromFileName(entry.path.split('/').at(-1) ?? '');
  const meta = validateAttachmentMeta({ size: entry.size, contentType: contentType ?? '' }, { maxBytes: Math.min(ctx.limits.maxEntryBytes, ctx.settings.maxBytes), allowedTypes: ctx.settings.allowedTypes });
  if (contentType === undefined || (!meta.ok && meta.reason === 'type_not_allowed')) return { status: 'skipped', reason: 'type_not_allowed' };
  if (!meta.ok) return { status: 'skipped', reason: 'entry_too_large' };
  // The attachments table needs a size above 0 (an upload treats it as invalid): an empty file is not one.
  if (entry.size <= 0) return { status: 'skipped', reason: 'empty_file' };
  return { contentType };
}

/**
 * Stores a file as an attachment of one page, before the page's transaction: the bytes are counted as they come (a header that lies is `size_mismatch`), the first 512 bytes of an image
 * or a PDF must show the type the name declares (`type_mismatch`), and the object is put create-only under the tenant's prefix (an object that is there from an earlier attempt must be
 * of the same size). A crash after the put leaves at worst an orphan object, for the clean-up; the row is written with the page.
 */
export async function stageAttachment(ctx: StageContext, entry: ZipEntry, pagePath: string): Promise<Staged> {
  const judged = judgeFile(ctx, entry);
  if ('status' in judged) return { kind: 'rejected', ...judged };
  const read = await readEntry(ctx.reader, ctx.limits, entry, Math.min(ctx.limits.maxEntryBytes, ctx.settings.maxBytes));
  if (read.kind === 'too_large') return { kind: 'rejected', status: 'skipped', reason: 'entry_too_large' };
  if (read.kind === 'failed') return { kind: 'rejected', status: 'failed', reason: read.reason };
  if (isCheckedType(judged.contentType) && (await ctx.settings.sniff(read.bytes.subarray(0, 512))) !== judged.contentType) return { kind: 'rejected', status: 'skipped', reason: 'type_mismatch' };

  const fileName = cleanFileName(entry.path.split('/').at(-1) ?? 'file');
  return putObject(ctx, attachmentIdFor(ctx.importId, pagePath, entry.path), read.bytes, judged.contentType, fileName);
}

/** Puts the bytes create-only under the tenant's prefix (an object that is there from an earlier attempt must be of the same size) and answers the row and the address of the attachment. */
async function putObject(ctx: StageContext, id: string, bytes: Buffer, contentType: string, fileName: string): Promise<Staged> {
  const key = attachmentKey(id, ctx.tenantId);
  try {
    await ctx.files.put(key, bytes, { size: bytes.length, contentType, ifNoneMatch: true });
  } catch (e) {
    if (!(e instanceof FileStorageError) || e.kind !== 'already-exists') throw e;
    // An earlier attempt put it: it is the file when it has the same size.
    if ((await ctx.files.head(key)).size !== bytes.length) return { kind: 'rejected', status: 'failed', reason: 'size_mismatch', scope: 'page' };
  }
  return { kind: 'ok', row: { id, uploaderId: ctx.uploaderId, fileName, contentType, size: bytes.length, key, readyAt: ctx.now() }, url: markdownPathFor(id, fileName) };
}

const EXTENSION: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };

/** The name a copied image is given: the last segment of the URL's path, or `image` and the type's extension when the URL names none. */
function remoteFileName(url: string, contentType: string): string {
  let last = '';
  try { last = decodeURIComponent(new URL(url).pathname.split('/').filter((x) => x !== '').at(-1) ?? ''); } catch { last = ''; }
  const name = cleanFileName(last === '' ? `image.${EXTENSION[contentType] ?? 'bin'}` : last);
  return name;
}

export type RemoteStaged = StagedFile | { readonly kind: 'failed'; readonly reason: string };

/**
 * Copies a remote image into the tool before its page is written (M7 contracts section 5): the fetcher does the network and the checks of the address, the type and the size; what comes
 * back is read to the end (at most the files limit), must be of a type an upload may be, non-empty, and must show that type in its first 512 bytes, and is put as an attachment of the
 * page under an id made of the import, the page and the URL. Any refusal is a failure of this image only.
 */
export async function stageRemoteImage(ctx: StageContext, fetcher: { fetch(url: string, budget: RemoteBudget): Promise<RemoteResult> }, budget: RemoteBudget, url: string, pagePath: string): Promise<RemoteStaged> {
  const got = await fetcher.fetch(url, budget);
  if (!got.ok) return { kind: 'failed', reason: got.reason };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of got.bytes) {
    total += chunk.length;
    if (total > ctx.settings.maxBytes) return { kind: 'failed', reason: 'too_large' };
    chunks.push(Buffer.from(chunk));
  }
  const contentType = got.contentType.toLowerCase();
  const meta = validateAttachmentMeta({ size: total, contentType }, { maxBytes: ctx.settings.maxBytes, allowedTypes: ctx.settings.allowedTypes });
  if (!meta.ok) return { kind: 'failed', reason: meta.reason === 'too_large' ? 'too_large' : 'type' };
  if (total === 0) return { kind: 'failed', reason: 'empty' };
  const bytes = Buffer.concat(chunks);
  if (isCheckedType(contentType) && (await ctx.settings.sniff(bytes.subarray(0, 512))) !== contentType) return { kind: 'failed', reason: 'type' };
  const put = await putObject(ctx, attachmentIdFor(ctx.importId, pagePath, url), bytes, contentType, remoteFileName(url, contentType));
  return put.kind === 'ok' ? put : { kind: 'failed', reason: put.reason };
}
