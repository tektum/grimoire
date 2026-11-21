import type {
  ConvertResult,
  MarkdownConverter,
  SeedResult,
} from '../ports/markdown-converter.js';

const CLOSED = { ok: false, reason: 'internal', detail: 'closed' } as const;

/** What a call returns: a fixed result, or a function of the input. */
type Script<In, Out> = Out | ((input: In) => Out);

export interface FakeMarkdownConverterOptions {
  /** Used for each `toMarkdown` call after the scripted ones run out. Default: empty Markdown and text. */
  convert?: Script<Uint8Array, ConvertResult>;
  /** Used for each `seed` call after the scripted ones run out. Default: an empty state. */
  seed?: Script<string, SeedResult>;
}

/** Scripted converter: returns the queued results in order, then the default, and counts calls. */
export class FakeMarkdownConverter implements MarkdownConverter {
  readonly convertCalls: Uint8Array[] = [];
  readonly seedCalls: string[] = [];
  private readonly convertQueue: Script<Uint8Array, ConvertResult>[] = [];
  private readonly seedQueue: Script<string, SeedResult>[] = [];
  private closed = false;

  constructor(private readonly options: FakeMarkdownConverterOptions = {}) {}

  /** Queue the result of the next unscripted `toMarkdown` call. */
  enqueueConvert(result: Script<Uint8Array, ConvertResult>): this {
    this.convertQueue.push(result);
    return this;
  }

  /** Queue the result of the next unscripted `seed` call. */
  enqueueSeed(result: Script<string, SeedResult>): this {
    this.seedQueue.push(result);
    return this;
  }

  get closeRequested(): boolean {
    return this.closed;
  }

  toMarkdown(state: Uint8Array): Promise<ConvertResult> {
    if (this.closed) return Promise.resolve({ ...CLOSED });
    this.convertCalls.push(state);
    const script = this.convertQueue.shift() ?? this.options.convert ?? { ok: true, markdown: '', text: '' };
    return Promise.resolve(typeof script === 'function' ? script(state) : script);
  }

  seed(markdown: string): Promise<SeedResult> {
    if (this.closed) return Promise.resolve({ ...CLOSED });
    this.seedCalls.push(markdown);
    const script = this.seedQueue.shift() ?? this.options.seed ?? { ok: true, state: new Uint8Array(0) };
    return Promise.resolve(typeof script === 'function' ? script(markdown) : script);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
