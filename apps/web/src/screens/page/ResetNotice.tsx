import { useState } from 'react';
import { TEXTS } from '../../editor/core/map-signal';
import { Button } from '../../ui/primitives';

/** The name of the downloaded copy: the page's title (made safe for a file name) and "-your-copy.md". */
export function copyFileName(title: string): string {
  const base = title
    .replace(/[^\p{L}\p{N}_ -]+/gu, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .slice(0, 80);
  return `${base === '' || /^-+$/.test(base) ? 'page' : base}-your-copy.md`;
}

/** Saves the text as a Markdown file: from a Blob made here, held in memory only, and let go as soon as the download has started. */
export function downloadCopy(text: string, title: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = copyFileName(title);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Shown after a page was reset while this tab held unsent changes: the changes were not applied, and the tab keeps a Markdown copy of them (in memory
 * only) to save, to copy, or to leave.
 */
export function ResetNotice({ copy, title, onDismiss }: { copy: string; title: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const copyToClipboard = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(copy);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="page-reset" role="alert">
      <p>{TEXTS.reset}</p>
      <div className="page-reset-actions">
        <Button variant="primary" onClick={() => downloadCopy(copy, title)}>
          Download my copy
        </Button>
        <Button onClick={() => void copyToClipboard()}>Copy to clipboard</Button>
        <Button onClick={onDismiss}>Dismiss</Button>
      </div>
      {copied === 'done' ? <p className="page-reset-note">Copied.</p> : null}
      {copied === 'failed' ? <p className="page-reset-note">This browser did not allow copying. Use Download my copy.</p> : null}
    </div>
  );
}
