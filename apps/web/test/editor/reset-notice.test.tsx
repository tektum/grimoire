import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVOKE_AFTER_MS, ResetNotice, copyFileName, downloadCopy } from '../../src/screens/page/ResetNotice';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('the name of the downloaded copy', () => {
  it('is the title and -your-copy.md', () => {
    expect(copyFileName('Plan')).toBe('Plan-your-copy.md');
    expect(copyFileName('Release notes 2026')).toBe('Release notes 2026-your-copy.md');
    expect(copyFileName('Ünïcode — titre')).toBe('Ünïcode - titre-your-copy.md');
  });

  it('cannot leave the folder or hide an extension: path characters become dashes, and an empty title is "page"', () => {
    expect(copyFileName('../../etc/passwd')).toBe('-etc-passwd-your-copy.md');
    expect(copyFileName('a/b:c*d?.exe')).toBe('a-b-c-d-exe-your-copy.md');
    expect(copyFileName('')).toBe('page-your-copy.md');
    expect(copyFileName('////')).toBe('page-your-copy.md');
    expect(copyFileName('x'.repeat(300)).length).toBeLessThan(100);
  });
});

describe('downloading the copy', () => {
  it('makes a Markdown file from a Blob held in memory, clicks a link for it, and lets the Blob go a little later, not in the same task', async () => {
    vi.useFakeTimers();
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => ((blob = b), 'blob:copy'));
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    });
    downloadCopy('# My text\n', 'Plan');
    expect(clicks).toEqual([{ href: 'blob:copy', download: 'Plan-your-copy.md' }]);
    expect(blob!.type).toBe('text/markdown');
    expect(await blob!.text()).toBe('# My text\n');
    expect(revoke).not.toHaveBeenCalled(); // some browsers read the Blob after the click's task
    vi.advanceTimersByTime(REVOKE_AFTER_MS);
    expect(revoke).toHaveBeenCalledWith('blob:copy');
    vi.useRealTimers();
    expect(document.querySelector('a[download]')).toBeNull(); // the link is not left in the page
  });
});

describe('the reset notice', () => {
  const show = (over: { copy?: string; onDismiss?: () => void } = {}) => render(<ResetNotice copy={over.copy ?? '# Mine'} title="Plan" onDismiss={over.onDismiss ?? (() => undefined)} />);

  it('says what happened and offers the three buttons', () => {
    show();
    expect(screen.getByRole('alert').textContent).toContain('This page was reset. Your unsent changes were not applied.');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Download my copy', 'Copy to clipboard', 'Dismiss']);
  });

  it('Download my copy saves the copy under the page title', () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Download my copy' }));
    expect(names).toEqual(['Plan-your-copy.md']);
  });

  it('Copy to clipboard writes the copy and says so', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show({ copy: '# Mine, copied' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => expect(screen.getByText('Copied.')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith('# Mine, copied');
  });

  it('says so, and points to the download, when the browser does not allow copying', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => Promise.reject(new Error('denied')) }, configurable: true });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => expect(screen.getByText(/did not allow copying/)).toBeTruthy());
  });

  it('says so when there is no clipboard at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => expect(screen.getByText(/did not allow copying/)).toBeTruthy());
  });

  it('Dismiss tells the screen, which drops the copy', () => {
    const onDismiss = vi.fn();
    show({ onDismiss });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
