import type { components } from '@tektum/grimoire-api-client';
import { reasonText } from './reasons';

export type Revision = Readonly<components['schemas']['Revision']>;

const FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Who edited, in one phrase: the last author, then the others who took part. */
export function authorsText(revision: Revision): string {
  const last = revision.lastAuthor;
  const others = revision.authors.filter((a) => a.id !== last?.id).map((a) => a.name);
  if (last === null) return others.length === 0 ? 'No author recorded' : `Edited by ${others.join(', ')}`;
  return others.length === 0 ? `Last edit by ${last.name}` : `Last edit by ${last.name}, with ${others.join(', ')}`;
}

/** When a version was kept, why, and who edited it. */
export function RevisionMeta({ revision }: { readonly revision: Revision }) {
  const at = new Date(revision.createdAt);
  return (
    <p className="history-meta">
      <time dateTime={at.toISOString()}>{FORMAT.format(at)}</time>
      <span data-testid="reason">{reasonText(revision.reason)}</span>
      <span>{authorsText(revision)}</span>
    </p>
  );
}
