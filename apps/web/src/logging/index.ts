export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** Only scalar fields are accepted, so a token or a document cannot be passed as an object by mistake. */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  console[level === 'debug' ? 'debug' : level](JSON.stringify({ level, event, ...fields }));
}
