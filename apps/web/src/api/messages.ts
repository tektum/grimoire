/** Every text the API wrapper shows, in one place so the wording is reviewed together (contracts section 5). */
export const MESSAGES: Readonly<Record<string, string>> = {
  would_create_cycle: "A page can't be moved into itself or its own sub-pages",
  too_deep: "Pages can't be nested this deep",
  collection_full: 'This collection is full',
  collection_deleted: 'This collection was deleted',
  name_taken: 'That name is already used',
  last_admin: 'There must be at least one admin',
  save_failed: "Couldn't save. Try again",
  conflict: 'Someone else changed this. Reloaded',
  too_large: 'That file is too large',
  type_not_allowed: "That file type isn't allowed",
  type_mismatch: "The file doesn't look like its type",
  upload_missing: "The upload didn't finish. Try again",
  size_mismatch: "The upload didn't finish. Try again",
  rate_limited: 'Too many requests. Try again in a moment',
  forbidden: "You can't do that here",
  invalid: 'Check the value and try again',
  unavailable: 'Try again',
  markdown_stale: 'The page changed since you opened it',
  client_too_old: 'A new version is available. Reload.',
};
export const FALLBACK_MESSAGE = 'Something went wrong';
export const rateLimitedMessage = (seconds: number): string => `Slow down, trying again in ${seconds} seconds`;
export const messageFor = (code: string | undefined): string => (code !== undefined ? MESSAGES[code] : undefined) ?? FALLBACK_MESSAGE;
