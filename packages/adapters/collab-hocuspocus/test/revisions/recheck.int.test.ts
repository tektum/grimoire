import { afterEach, describe, expect, it } from 'vitest';
import type { VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import type { PageWrite } from '@tektum/grimoire-core/ports/collaboration-host';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { connect, eventually, startLive } from '../host/live-support.js';
import type { Client, Live } from '../host/live-support.js';
import { PAGE, SUBJECT, U1 } from '../host/support.js';

// The revision rules on a real socket and the real Hocuspocus server, over fake stores: the access re-check (1-second interval, real timers)
// closes the connection of the last editor, and the page's last save and unload follow.
const lives: Live[] = [];
const clients: { destroy(): void }[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const l of lives.splice(0)) await l.stop();
});

async function live(): Promise<{ l: Live; revisions: FakeRevisionRepo }> {
  const revisions = new FakeRevisionRepo();
  const l = await startLive('member', {}, (t) => {
    t.deps = { ...t.deps, revisions, config: makeFakeConfig({ collab: { recheckSeconds: 1, debounceMs: 100, maxDebounceMs: 500 } }) };
    t.verifier.verify = (token: string): Promise<VerifyResult> => Promise.resolve({ kind: 'ok', userId: token, expiresAt: t.clock.now() + 3_600_000 });
    // The revision repository reads the saved state the page store holds: every converted save is what a revision would copy.
    const store = t.pages.store.bind(t.pages);
    t.pages.store = async (id: string, w: PageWrite) => {
      const outcome = await store(id, w);
      if (w.kind === 'converted' && outcome.written) revisions.setPage(id, { title: 'Title', markdown: w.markdown });
      return outcome;
    };
  });
  lives.push(l);
  l.t.pages.seed(PAGE);
  return { l, revisions };
}
const open = (l: Live): Client => {
  const c = connect(l, PAGE, SUBJECT, { maxAttempts: 1 });
  clients.push(c);
  return c;
};
const authed = (c: Client): Promise<true> => eventually(() => c.provider.isAuthenticated, 5000, 'authenticated');
const savedMarkdown = (l: Live): string | null => l.t.pages.markdowns.get(PAGE) ?? null;

describe('the last editor closed by the access re-check', () => {
  it('after editing: exactly one revision, with that editor among its authors and the last saved state as its content', { timeout: 20_000 }, async () => { // real socket, real re-check tick, real debounce
    const { l, revisions } = await live();
    const editor = open(l);
    await authed(editor);
    const reasons: string[] = [];
    editor.provider.on('close', ({ event }: { event: { reason: string } }) => { reasons.push(event.reason); });
    editor.text.insert(0, 'written before the access was taken away;');
    await eventually(() => savedMarkdown(l) !== null, 5000, 'the edit is saved');
    editor.text.insert(0, 'a second edit;');
    l.t.users.suspend(SUBJECT);
    await eventually(() => reasons.length > 0, 5000, 'closed by the re-check');
    expect(reasons).toEqual(['access-changed']);
    await eventually(() => revisions.made(PAGE).length > 0, 5000, 'the revision of the last editor leaving');
    const made = revisions.made(PAGE);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ reason: 'last_editor_left', authors: [U1], lastAuthorId: U1, markdown: savedMarkdown(l) });
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.revision_created').map((e) => e.fields)).toEqual([{ pageId: PAGE, reason: 'last_editor_left' }]);
  });

  it('with no edit in the session: no revision and no database work for revisions', async () => {
    const { l, revisions } = await live();
    const viewer = open(l);
    await authed(viewer);
    const reasons: string[] = [];
    viewer.provider.on('close', ({ event }: { event: { reason: string } }) => { reasons.push(event.reason); });
    l.t.users.suspend(SUBJECT);
    await eventually(() => reasons.length > 0, 5000, 'closed by the re-check');
    await eventually(() => l.host.hocuspocus?.documents.get(PAGE) === undefined, 5000, 'the page is unloaded');
    expect(revisions.made(PAGE)).toEqual([]);
    expect(revisions.calls.filter((c) => c.startsWith('createFromPage'))).toEqual([]);
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.revision_created')).toEqual([]);
  });
});
