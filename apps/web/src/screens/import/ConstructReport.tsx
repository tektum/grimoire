import { Link } from 'react-router';
import type { ConstructLine, ImportConstructReport, ReportPage } from '../../import/types';
import { pagePath } from '../../tree/model';
import { CONSTRUCT_EFFECT, CONSTRUCT_NAME, fragmentsText, pagesSummary, rawHtmlCappedText } from './messages';

/** The link title of a page of the zip: the name of its file without the folders and the extension (only its letters and digits reach the address). */
const titleOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.[^.]*$/, '');

/** A page of the zip: a link to the page the import wrote, or its path as plain text when none was written (a row that was left out). The path is text, never markup. */
function PageRef({ page }: { readonly page: ReportPage }) {
  return page.urlId === null ? <span>{page.path}</span> : <Link to={pagePath(titleOf(page.path), page.urlId)}>{page.path}</Link>;
}

function Pages({ line }: { readonly line: ConstructLine }) {
  return (
    <details>
      <summary>{pagesSummary(line)}</summary>
      <ul>
        {line.pages.map((page) => (
          <li key={page.itemId}>
            <PageRef page={page} />
          </li>
        ))}
      </ul>
      {line.capped ? <p>More pages hold it than are listed here.</p> : null}
    </details>
  );
}

/**
 * What the import did to the content of the pages it wrote (the report of constructs of `GET /v1/imports/{id}`): for each kind of content what became of it (converted, left out, kept as written), how
 * many there were, and the pages that hold it; and the pages that still hold HTML, so that someone can clean them up. Nothing is shown for a server that does not say, or when there was nothing to report.
 */
export function ConstructReport({ report }: { readonly report: ImportConstructReport | undefined }) {
  if (report === undefined || (report.constructs.length === 0 && report.rawHtmlPages.length === 0)) return null;
  return (
    <section aria-labelledby="import-constructs-title" className="import-constructs">
      <h2 id="import-constructs-title">What happened to the content</h2>
      {report.constructs.length === 0 ? null : (
        <table>
          <caption>What the import did to each kind of content in the pages it wrote</caption>
          <thead>
            <tr>
              <th scope="col">Content</th>
              <th scope="col">What happened, and where</th>
              <th scope="col">How many</th>
            </tr>
          </thead>
          <tbody>
            {report.constructs.map((line) => (
              <tr key={line.kind} data-fate={line.fate}>
                <th scope="row">{CONSTRUCT_NAME[line.kind]}</th>
                <td>
                  <span>{CONSTRUCT_EFFECT[line.kind]}</span>
                  <Pages line={line} />
                </td>
                <td>{String(line.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.rawHtmlPages.length === 0 ? null : (
        <div className="import-raw-html">
          <h3>Pages that still hold HTML</h3>
          <p>Open each page and clean up the HTML by hand.</p>
          <ul>
            {report.rawHtmlPages.map((page) => (
              <li key={page.itemId}>
                <PageRef page={page} /> ({fragmentsText(page.fragments)})
              </li>
            ))}
          </ul>
          {report.rawHtmlCapped ? <p>{rawHtmlCappedText(report.rawHtmlPages.length)}</p> : null}
        </div>
      )}
    </section>
  );
}
