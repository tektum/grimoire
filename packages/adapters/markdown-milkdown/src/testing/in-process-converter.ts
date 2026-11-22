import type { ConvertResult, MarkdownConverter, SeedResult } from '@tektum/grimoire-core/ports/markdown-converter';
import { convertInProcess } from '../convert.js';
import type { ConverterLimits } from '../limits.js';
import { seedInProcess } from '../seed.js';

/** The port on the in-process functions, with no worker: for tests and for the worker pool's own tests. */
export class InProcessConverter implements MarkdownConverter {
  private closed = false;

  constructor(private readonly limits?: Partial<ConverterLimits>) {}

  toMarkdown(state: Uint8Array): Promise<ConvertResult> {
    if (this.closed) return Promise.resolve({ ok: false, reason: 'internal', detail: 'closed' });
    return convertInProcess(state, this.limits);
  }

  seed(markdown: string): Promise<SeedResult> {
    if (this.closed) return Promise.resolve({ ok: false, reason: 'internal', detail: 'closed' });
    return seedInProcess(markdown, this.limits);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
