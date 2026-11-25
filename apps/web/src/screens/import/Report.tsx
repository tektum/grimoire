import { useState } from 'react';
import { sourceUrl, useImportReport } from '../../import/api';
import type { ImportItem } from '../../import/types';
import type { ApiLike } from '../../api/query';
import { isSafeHref } from '../../safety';
import { Button } from '../../ui/primitives';
import { useApiQuery } from '../../api/query';
import { importLimitsOf, reasonText } from './messages';

const STATUS: Record<ImportItem['status'], string> = { ok: 'Imported', skipped: 'Skipped', failed: 'Failed' };

/** Hands the browser the address of a file to download. Only an address `isSafeHref` accepts is used; the anchor is the browser's own way to start a download. */
function download(url: string): boolean {
  if (!isSafeHref(url)) return false;
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.download = '';
  a.click();
  return true;
}

/** What happened to each file of an ended import. Names and reasons are text, never markup. A failed page whose original is kept can be downloaded. */
export function Report({ api, id }: { readonly api: ApiLike; readonly id: string }) {
  const report = useImportReport(api, id);
  // The limits a reason names are the server's (`GET /v1/config`); until they are known, or when it does not say, the sentence has no number.
  const limits = importLimitsOf(useApiQuery(api, '/v1/config').data);
  const [problem, setProblem] = useState<string | null>(null);
  const fetchSource = async (item: ImportItem): Promise<void> => {
    setProblem(null);
    try {
      if (!download(await sourceUrl(api, id, item.id))) setProblem(item.id);
    } catch {
      setProblem(item.id);
    }
  };
  return (
    <section aria-labelledby="import-report-title" className="import-report">
      <h2 id="import-report-title">Report</h2>
      {report.phase === 'error' ? (
        <p role="alert">
          The report can&rsquo;t be read right now. <Button onClick={report.more}>Try again</Button>
        </p>
      ) : null}
      {report.phase === 'ready' && report.items.length === 0 ? <p>There is nothing to list.</p> : null}
      <ul aria-label="Files of the import" className="import-report-list">
        {report.items.map((item) => (
          <li key={item.id} data-status={item.status}>
            <span className="import-report-path">{item.path}</span> <span className="import-report-status">{STATUS[item.status]}</span>
            {reasonText(item, limits) === null ? null : <span className="import-report-message"> {reasonText(item, limits)}</span>}
            {item.status === 'failed' && item.hasSource ? (
              <Button
                aria-label={`Download source of ${item.path}`}
                onClick={() => {
                  void fetchSource(item);
                }}
              >
                Download source
              </Button>
            ) : null}
            {problem === item.id ? <span role="alert"> The source can&rsquo;t be downloaded right now.</span> : null}
          </li>
        ))}
      </ul>
      {/* Not a live region: the line that says how the import ended (Progress) is the one status of the screen, and a second one would be read out over it while the report loads. */}
      {report.phase === 'loading' ? <p>Loading the report…</p> : null}
      {report.phase === 'ready' && report.hasMore ? <Button onClick={report.more}>Show more</Button> : null}
    </section>
  );
}
