const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ATTACHMENT_SRC = new RegExp(`^attachments/(${UUID})/[^/?#]+$`, 'i');

/**
 * The id of the attachment an image source names, or null for any other source. Only this exact shape, `attachments/<uuid>/<name>` (the `markdownPath` the server
 * returns), is mapped to a signed link: any other relative path (`./x.png`) would be loaded from the app's own address, which is not where files are kept.
 */
export function attachmentId(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  const match = ATTACHMENT_SRC.exec(src);
  return match === null ? null : match[1]!.toLowerCase();
}

/** What a source that is not an uploaded file says in place of the image: where it would have come from. */
export function placeholderHost(src: string): string {
  try {
    const url = new URL(src.startsWith('//') ? `https:${src}` : src); // no scheme but a host: an external address
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname;
    return url.protocol === 'data:' ? 'embedded data' : url.protocol;
  } catch {
    return src.length > 60 ? `${src.slice(0, 57)}…` : src; // a relative path: no host
  }
}
