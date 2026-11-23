import { replayCreateCollection } from '../routes/collections.js';
import { replayCreateGroup } from '../routes/groups.js';
import { replayResetState } from '../routes/reset-state.js';
import { replayCreatePage } from '../routes/pages.js';
import type { ReplayRebuild } from './idempotency.js';

/** The replay hooks of the idempotent routes that need one, by `"METHOD /route/pattern"`. A route that needs one adds its line here. */
export const routeReplays: Readonly<Record<string, ReplayRebuild>> = {
  'POST /v1/collections': replayCreateCollection,
  'POST /v1/groups': replayCreateGroup,
  'POST /v1/pages/:id/reset-state': replayResetState,
  'POST /v1/pages': replayCreatePage,
};
