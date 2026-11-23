import { cleanFileName } from './file-name.js';

/** The object key of an attachment: its id and nothing a user wrote. */
export const attachmentKey = (id: string): string => `attachments/${id}`;

/** `encodeURIComponent` leaves `! ' ( ) *` as they are; they end or open things in a Markdown link destination, so they are encoded too. */
const encodeSegment = (segment: string): string => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The path an editor writes into the Markdown of a page for an attachment: `attachments/<id>/<cleaned name>`, each segment percent-encoded, so a name with a space,
 * `#`, `%`, brackets, parentheses or a colon is still one relative path (a colon would otherwise read as a scheme) and survives the Markdown writer unchanged.
 */
export const markdownPathFor = (id: string, fileName: string): string => ['attachments', id, cleanFileName(fileName)].map(encodeSegment).join('/');
