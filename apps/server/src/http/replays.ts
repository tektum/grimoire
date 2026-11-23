import { replayCreatePage } from '../routes/pages.js';
import type { ReplayRebuild } from './idempotency.js';

/** The replay hooks of the idempotent routes that need one, by `"METHOD /route/pattern"`. A route that needs one adds its line here. */
export const routeReplays: Readonly<Record<string, ReplayRebuild>> = {
  'POST /v1/pages': replayCreatePage,
};
