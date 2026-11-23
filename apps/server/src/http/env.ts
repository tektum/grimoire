import type { Profile } from '@tektum/grimoire-core/ports/auth-verifier';
import type { PageAccessChecker } from '@tektum/grimoire-core/authorize';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Config } from '@tektum/grimoire-core/ports/config';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { UserRecord, UserStore } from '@tektum/grimoire-core/ports/user-store';
import type { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import type { EventLog } from '../events.js';

export interface Identity { readonly userId: string; readonly profile?: Profile }

/** Every port a route may use. Handlers read it from the context; a router keeps no state of its own. */
export interface HttpDeps {
  readonly config: Config;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly users: UserStore;
  readonly access: PageAccessChecker;
  readonly provisioner: ReturnType<typeof createProvisioner>;
  /** Routes may only seed. The rebuild from stored Markdown belongs to the collaboration host. */
  readonly converter: MarkdownConverter;
}

export type AppEnv = { Variables: { deps: HttpDeps; identity?: Identity; user?: UserRecord } };
