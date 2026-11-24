import { createRoot, type Root } from 'react-dom/client';
import type { ConnectionState } from '../../src/editor/core/connection';
import { StatusLine, type StatusScope } from '../../src/status';
import { PageMenu } from '../../src/screens/page/PageMenu';
import '../../src/screens/page/page.css';
import '../../src/ui/global.css';

interface Show {
  readonly title: string;
  readonly collab: StatusScope;
  readonly state: Partial<Pick<ConnectionState, 'text' | 'unsynced' | 'changes' | 'readOnly' | 'banner' | 'stopped'>>;
  readonly readOnly?: boolean;
  readonly admin?: boolean;
  readonly body?: string[];
}

let root: Root | null = null;

/**
 * Bundled by the screenshot spec: the head of the page screen (its title, the status line and its banner) over a few paragraphs of text, in the page's own styles. The
 * status line is the real component, given the state the spec names.
 */
(window as unknown as { show: (options: Show) => void }).show = ({ title, collab, state, readOnly, admin, body = [] }) => {
  const host = document.getElementById('host');
  if (host === null) throw new Error('no host element');
  root ??= createRoot(host);
  root.render(
    <div className="page-layout">
      <article className="page">
        <header className="page-head">
          <h1 id="screen-title">{title}</h1>
          {readOnly === true ? <span className="page-readonly">Read only</span> : null}
          <PageMenu onHistory={() => undefined} onReset={admin === true ? () => undefined : undefined} />
        </header>
        <StatusLine state={{ text: null, unsynced: 0, changes: 0, readOnly: false, stopped: null, ...state }} collab={collab} onRetry={() => undefined} />
        {state.banner === undefined || state.banner === null ? null : <p className="page-banner">{state.banner}</p>}
        <div className="page-editor page-text">
          {body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </article>
    </div>,
  );
};
