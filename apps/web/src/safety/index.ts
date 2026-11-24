import { isSafeUrl } from '@tektum/grimoire-editor-schema';

/**
 * Whether an address may be the target of a link the client shows or keeps. A thin wrapper over the one allow-list of the
 * editor schema, so the client and the saved Markdown can never disagree about which addresses are safe. There is no list
 * of schemes here on purpose.
 */
export function isSafeHref(value: unknown): boolean {
  return isSafeUrl(value, 'link');
}

export { rawHtmlPlugin, rawHtmlView } from './raw-html';
