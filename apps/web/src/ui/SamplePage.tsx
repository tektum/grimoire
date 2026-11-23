import type { CSSProperties } from 'react';
import { COLLAB_COLOURS, labelText } from './collab';

const TOKENS = ['paper', 'ink', 'accent', 'muted', 'border', 'focus'] as const;
const NAMES = ['Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia'] as const;

function Cursor({ index, name }: { index: number; name: string }) {
  const colour = COLLAB_COLOURS[index]!;
  return (
    <span className="cursor" style={{ '--cursor': colour, '--cursor-text': labelText(colour) } as CSSProperties}>
      <span className="cursor-label">{name}</span>
      {'\u200b'}
    </span>
  );
}

/** Marker checked by `check:build`: a production build must not contain it. */
export const SAMPLE_MARKER = 'grimoire-design-sample';

/** A page of sample content for judging the look and feel (shown in development and test builds only). */
export default function SamplePage() {
  return (
    <div className="sample-grid" data-sample={SAMPLE_MARKER}>
      <article className="page-text" aria-labelledby="sample-title">
        <h1 id="sample-title">Planning the autumn release</h1>
        <p>
          The release is on track. Read the <a href={`${location.pathname}${location.search}#plan`}>plan below</a>, then add your notes:{' '}
          <Cursor index={0} name="Ada" />
          every edit appears for the others as you type, and <Cursor index={1} name="Grace" />
          their cursors carry a name, so nobody has to guess who is where.
        </p>
        <h2 id="plan">What is left</h2>
        <ul>
          <li>Finish the import checks for large pages</li>
          <li>
            Review the <code>history</code> screen with two editors
          </li>
          <li>Write the short guide for new members</li>
        </ul>
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Owner</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Import</td>
              <td>Linus</td>
              <td>In review</td>
            </tr>
            <tr>
              <td>History</td>
              <td>Margaret</td>
              <td>Started</td>
            </tr>
            <tr>
              <td>Guide</td>
              <td>Dennis</td>
              <td>Not started</td>
            </tr>
          </tbody>
        </table>
        <pre>
          <code>{`const ready = pages.filter((page) => page.status === 'done');\nconsole.log(\`\${ready.length} of \${pages.length} pages are done\`);`}</code>
        </pre>
      </article>
      <aside aria-label="Colours">
        <h2>Tokens</h2>
        <ul className="token-row" aria-label="Tokens">
          {TOKENS.map((name) => (
            <li key={name} className="token-chip">
              <i style={{ background: `var(--${name})` }} />
              {name}
            </li>
          ))}
          <li className="token-chip">
            <i style={{ background: 'var(--paper)', outline: '2px solid var(--focus)', outlineOffset: 1 }} />
            focus ring
          </li>
        </ul>
        <h2>Collaborators</h2>
        <ul className="swatches" aria-label="Collaborator colours">
          {COLLAB_COLOURS.map((colour, i) => (
            <li key={colour} className="swatch" style={{ background: colour, color: labelText(colour) }}>
              {NAMES[i]}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
