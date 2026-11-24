import { describe, expect, it } from 'vitest';
import { PartialFileDeletion, purgeBatch } from '../../src/pages/purge.js';
import { FakeTrashRepo } from '../../src/testing/fake-trash-repo.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const COLLECTION = '00000000-0000-4000-8000-0000000000c1';

/** A batch of a root and a child, the child with two attachments; and a second, unrelated batch. */
function build(deleteFiles: (keys: readonly string[]) => Promise<void>) {
  const trash = new FakeTrashRepo();
  const root = trash.seedDeleted({ collectionId: COLLECTION, title: 'root' });
  const child = trash.seedDeleted({ collectionId: COLLECTION, parentId: root, batch: root, attachments: ['attachments/a/1/x.png', 'attachments/a/2/y.png'] });
  const other = trash.seedDeleted({ collectionId: COLLECTION, attachments: ['attachments/b/1/z.png'] });
  const events: string[] = [];
  const traced: typeof deleteFiles = async (keys) => {
    events.push(`files:${keys.join(',')}:rows-still-there=${String(trash.state(root) === 'deleted')}`);
    await deleteFiles(keys);
  };
  return { trash, root, child, other, events, deps: { trash, deleteFiles: traced } };
}

describe('purgeBatch', () => {
  it('removes the objects first and then every page row of the batch, and no other batch', async () => {
    const b = build(() => Promise.resolve());
    const out = await purgeBatch(b.deps, 'legacy', b.root, ADMIN);
    expect(out).toEqual({ pages: 2, files: 2 });
    expect(b.events).toEqual(['files:attachments/a/1/x.png,attachments/a/2/y.png:rows-still-there=true']);
    expect([b.trash.state(b.root), b.trash.state(b.child), b.trash.state(b.other)]).toEqual(['gone', 'gone', 'deleted']);
  });

  it('writes exactly one audit row with ids only', async () => {
    const b = build(() => Promise.resolve());
    await purgeBatch(b.deps, 'legacy', b.root, ADMIN);
    expect(b.trash.audit.events).toEqual([{ actorId: ADMIN, action: 'page.purged', targetType: 'page', targetId: b.root, detail: { batch: b.root, pages: 2 }, tenantId: 'legacy' }]);
  });

  it('leaves every row and writes no audit row when the objects cannot be removed, so it can be run again', async () => {
    let fail = true;
    const b = build(() => (fail ? Promise.reject(new Error('store down')) : Promise.resolve()));
    await expect(purgeBatch(b.deps, 'legacy', b.root, ADMIN)).rejects.toThrow('store down');
    expect([b.trash.state(b.root), b.trash.state(b.child)]).toEqual(['deleted', 'deleted']);
    expect(b.trash.audit.events).toEqual([]);
    fail = false;
    expect(await purgeBatch(b.deps, 'legacy', b.root, ADMIN)).toEqual({ pages: 2, files: 2 });
  });

  it('marks the attachments whose objects the store did remove before it failed, and rethrows the failure; a retry completes', async () => {
    let fail = true;
    const b = build(async (keys) => {
      if (fail) throw new PartialFileDeletion([keys[0] as string], new Error('store down'));
    });
    await expect(purgeBatch(b.deps, 'legacy', b.root, ADMIN)).rejects.toThrow('store down');
    expect([b.trash.keyDeleted('attachments/a/1/x.png'), b.trash.keyDeleted('attachments/a/2/y.png')]).toEqual([true, false]);
    expect([b.trash.state(b.root), b.trash.state(b.child)]).toEqual(['deleted', 'deleted']);
    expect(b.trash.audit.events).toEqual([]);
    fail = false;
    expect(await purgeBatch(b.deps, 'legacy', b.root, ADMIN)).toEqual({ pages: 2, files: 2 });
  });

  it('tries the marker a second time when the first fails, and still reports the store failure when it keeps failing', async () => {
    const flaky = build(() => Promise.reject(new PartialFileDeletion(['attachments/a/1/x.png'], new Error('store down'))));
    const real = flaky.trash.markFilesRemoved.bind(flaky.trash);
    let calls = 0;
    flaky.trash.markFilesRemoved = (keys) => { calls += 1; return calls === 1 ? Promise.reject(new Error('db blip')) : real(keys); };
    await expect(purgeBatch(flaky.deps, 'legacy', flaky.root, ADMIN)).rejects.toThrow('store down');
    expect([calls, flaky.trash.keyDeleted('attachments/a/1/x.png')]).toEqual([2, true]);
    const broken = build(() => Promise.reject(new PartialFileDeletion(['attachments/a/1/x.png'], new Error('store down'))));
    let attempts = 0;
    broken.trash.markFilesRemoved = () => { attempts += 1; return Promise.reject(new Error('db down')); };
    await expect(purgeBatch(broken.deps, 'legacy', broken.root, ADMIN)).rejects.toThrow('store down');
    expect(attempts).toBe(2);
  });

  it('marks nothing when the store removed nothing, and passes any other failure on as it is', async () => {
    const none = build(() => Promise.reject(new PartialFileDeletion([], new Error('first key failed'))));
    await expect(purgeBatch(none.deps, 'legacy', none.root, ADMIN)).rejects.toThrow('first key failed');
    expect(none.trash.keyDeleted('attachments/a/1/x.png')).toBe(false);
    const other = build(() => Promise.reject(new Error('plain')));
    await expect(purgeBatch(other.deps, 'legacy', other.root, ADMIN)).rejects.toThrow('plain');
  });

  it('is a no-op for a batch that is already gone: no files asked for, no second audit row', async () => {
    const b = build(() => Promise.resolve());
    await purgeBatch(b.deps, 'legacy', b.root, ADMIN);
    b.events.length = 0;
    expect(await purgeBatch(b.deps, 'legacy', b.root, ADMIN)).toEqual({ pages: 0, files: 0 });
    expect(b.events).toEqual([]);
    expect(b.trash.audit.events).toHaveLength(1);
  });

  it('takes a page below the batch that was deleted earlier, with its files', async () => {
    const trash = new FakeTrashRepo();
    const parent = trash.seedDeleted({ collectionId: COLLECTION });
    const early = trash.seedDeleted({ collectionId: COLLECTION, parentId: parent, attachments: ['attachments/e/1/e.png'] });
    const asked: string[] = [];
    expect(
      await purgeBatch(
        {
          trash,
          deleteFiles: (keys) => {
            asked.push(...keys);
            return Promise.resolve();
          },
        },
        'legacy',
        parent,
        ADMIN,
      ),
    ).toEqual({ pages: 2, files: 1 });
    expect(asked).toEqual(['attachments/e/1/e.png']);
    expect([trash.state(parent), trash.state(early)]).toEqual(['gone', 'gone']);
  });

  it('marks the objects it removed when a restore brought the page back in between, and writes no audit row', async () => {
    const trash = new FakeTrashRepo();
    const root = trash.seedDeleted({ collectionId: COLLECTION, attachments: ['attachments/r/1/r.png', 'attachments/r/2/s.png'] });
    const restored = () => trash.restore('legacy', root, COLLECTION, { maxDepth: 32, maxPages: 10_000 }, () => 'z');
    const out = await purgeBatch(
      {
        trash,
        deleteFiles: async () => {
          expect((await restored()).kind).toBe('restored');
        },
      },
      'legacy',
      root,
      ADMIN,
    );
    expect(out).toEqual({ pages: 0, files: 2 });
    expect(trash.state(root)).toBe('live');
    expect(trash.keyDeleted('attachments/r/1/r.png') && trash.keyDeleted('attachments/r/2/s.png')).toBe(true);
    expect(trash.audit.events).toEqual([]);
  });

  it('does not ask the file store anything for a batch without attachments', async () => {
    const trash = new FakeTrashRepo();
    const root = trash.seedDeleted({ collectionId: COLLECTION });
    const calls: (readonly string[])[] = [];
    expect(
      await purgeBatch(
        {
          trash,
          deleteFiles: (keys) => {
            calls.push(keys);
            return Promise.resolve();
          },
        },
        'legacy',
        root,
        ADMIN,
      ),
    ).toEqual({ pages: 1, files: 0 });
    expect(calls).toEqual([]);
  });
});
