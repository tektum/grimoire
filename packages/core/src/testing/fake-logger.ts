import type { Logger, LogLevel } from '../ports/logger.js';

export interface LogEntry {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

/** Captures structured entries in memory; children share the parent's list. */
export class FakeLogger implements Logger {
  readonly entries: LogEntry[];
  private readonly base: Record<string, unknown>;

  constructor(base: Record<string, unknown> = {}, entries: LogEntry[] = []) {
    this.base = base;
    this.entries = entries;
  }

  private add(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level, event, fields: { ...this.base, ...fields } });
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.add('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.add('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.add('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.add('error', event, fields); }

  child(fields: Record<string, unknown>): Logger {
    return new FakeLogger({ ...this.base, ...fields }, this.entries);
  }
}
