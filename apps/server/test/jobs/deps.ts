import { FakeAttachmentRepo } from '@tektum/grimoire-core/testing/fake-attachment-repo';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { FakeFileStorage } from '@tektum/grimoire-core/testing/fake-file-storage';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakePageStore } from '@tektum/grimoire-core/testing/fake-page-store';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { FakeTenantRepo } from '@tektum/grimoire-core/testing/fake-tenant-repo';
import { FakeTrashRepo } from '@tektum/grimoire-core/testing/fake-trash-repo';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createEventLog } from '../../src/events.js';
import type { JobDeps } from '../../src/jobs/index.js';

/** Every dependency of the registry as a fake, and the logger behind the event log. */
export function fakeJobDeps(over: Partial<JobDeps> = {}): { readonly deps: JobDeps; readonly logger: FakeLogger; readonly clock: FakeClock } {
  const logger = new FakeLogger();
  const clock = new FakeClock(1_000_000);
  const deps: JobDeps = {
    config: makeFakeConfig(), log: createEventLog(logger), clock, tenants: new FakeTenantRepo(['T-a']), trash: new FakeTrashRepo(), deleteFiles: () => Promise.resolve(),
    attachments: new FakeAttachmentRepo(), files: new FakeFileStorage(), revisions: new FakeRevisionRepo(), pages: new FakePageStore(), converter: new FakeMarkdownConverter(), ...over,
  };
  return { deps, logger, clock };
}
