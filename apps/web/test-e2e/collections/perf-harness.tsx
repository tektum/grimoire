import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { Tree } from '../../src/tree/Tree';
import { buildTree, type FlatPage } from '../../src/tree/model';

/** Bundled by tree-perf.spec.ts and run in Chromium: draws the tree of the given pages and returns the milliseconds it took, build of the nested list included. */
(window as unknown as { drawTree: (pages: FlatPage[]) => number }).drawTree = (pages) => {
  const start = performance.now();
  const host = document.getElementById('host');
  if (host === null) throw new Error('no host element');
  flushSync(() => {
    createRoot(host).render(
      <MemoryRouter>
        <Tree items={buildTree(pages)} />
      </MemoryRouter>,
    );
  });
  return performance.now() - start;
};
