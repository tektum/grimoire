import type { ApiClient, components } from '@tektum/grimoire-api-client';

/** What the server announces about uploads (`GET /v1/config`): the largest file, and how many unfinished uploads one person may have. Each is absent when it is not known. */
export interface UploadLimits {
  readonly maxBytes?: number;
  readonly pendingMax?: number;
}

const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);

/** The two numbers of the server's client configuration (`ClientConfig` of the generated types, so a renamed field fails to compile). */
export type AnnouncedLimits = Pick<components['schemas']['ClientConfig'], 'maxAttachmentBytes' | 'pendingUploadsMax'>;

/** The limits in a client configuration (a server that does not say, a store that is not configured, is "nothing known"). */
export function uploadLimitsOf(config: AnnouncedLimits | undefined): UploadLimits {
  const maxBytes = positive(config?.maxAttachmentBytes);
  const pendingMax = positive(config?.pendingUploadsMax);
  return { ...(maxBytes === undefined ? {} : { maxBytes }), ...(pendingMax === undefined ? {} : { pendingMax }) };
}

const UNITS: readonly (readonly [number, string])[] = [
  [1024 ** 3, 'GB'],
  [1024 ** 2, 'MB'],
  [1024, 'KB'],
];

/** A size as a person reads it: 25 MB, 1.5 MB, 512 KB, 800 bytes. */
export function formatBytes(bytes: number): string {
  for (const [size, unit] of UNITS) {
    if (bytes >= size) return `${String(Math.round((bytes / size) * 10) / 10)} ${unit}`;
  }
  return `${String(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

export const tooLargeMessage = (limits: UploadLimits | undefined): string => (limits?.maxBytes === undefined ? 'That file is too large' : `That file is over ${formatBytes(limits.maxBytes)}`);

export const tooManyMessage = (limits: UploadLimits | undefined): string =>
  limits?.pendingMax === undefined ? 'Too many uploads at once. Wait a moment.' : `Too many uploads at once (${String(limits.pendingMax)} is the most). Wait a moment.`;

/**
 * Asks for the limits the first time a refusal needs them (one `GET /v1/config`, kept), so a page that is never refused asks for nothing; a failed request is "nothing known"
 * and is asked again at the next refusal.
 */
export function lazyLimits(api: ApiClient): () => Promise<UploadLimits> {
  let known: Promise<UploadLimits> | undefined;
  return () => {
    known ??= api.GET('/v1/config').then(
      ({ data }) => {
        const limits = uploadLimitsOf(data);
        if (data === undefined) known = undefined;
        return limits;
      },
      () => {
        known = undefined;
        return {};
      },
    );
    return known;
  };
}
