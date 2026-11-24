import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { ApiLike } from '../../src/api/query';
import { ResetPageDialog } from '../../src/screens/admin/ResetPageDialog';
import '../../src/ui/global.css';

const API = 'http://127.0.0.1:8080';

/** A typed client of the one call the dialog makes, over the page's own `fetch`, so a spec sees the request as it goes out. */
const api = {
  POST: async (path: string, init: { params: { path: { id: string } }; body: unknown }) => {
    const response = await fetch(`${API}${path.replace('{id}', init.params.path.id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) });
    const parsed: unknown = await response.json().catch(() => undefined);
    return response.ok ? { data: parsed, response } : { error: parsed, response };
  },
} as unknown as ApiLike;

function Host() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => { setOpen(true); }}>Reset this page</button>
      <ResetPageDialog api={api} page={{ id: 'p1', title: 'Quarterly plan' }} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Bundled by the reset specs: the dialog, open, on a page of the spec's own server. */
(window as unknown as { show: () => void }).show = () => {
  const host = document.getElementById('host');
  if (host === null) throw new Error('no host element');
  createRoot(host).render(<Host />);
};
