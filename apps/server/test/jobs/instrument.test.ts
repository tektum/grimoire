import { describe, expect, it } from 'vitest';
import { instrument, reasonOf } from '../../src/jobs/instrument.js';
import { fakeJobDeps } from './deps.js';

const ctx = (over: { attempt?: number; retryLimit?: number; signal?: AbortSignal } = {}) => ({ jobId: 'j1', attempt: 1, retryLimit: 3, signal: new AbortController().signal, ...over });
const events = (logger: ReturnType<typeof fakeJobDeps>['logger']) => logger.entries.map((e) => `${e.level} ${e.event}`);

describe('instrument', () => {
  it('logs the start and the completion of a run, with its duration', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    await instrument('purge', async () => { clock.advance(40); }, deps.log, clock)({}, ctx());
    expect(logger.entries.map((e) => [e.event, e.fields])).toEqual([
      ['jobs.started', { name: 'purge', jobId: 'j1', attempt: 1, ms: 0 }],
      ['jobs.completed', { name: 'purge', jobId: 'j1', attempt: 1, ms: 40 }],
    ]);
  });

  it('logs a failure as retrying while retries remain and as failed on the last run, and rethrows it', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    const run = instrument('purge', () => Promise.reject(new Error('secret detail')), deps.log, clock);
    await expect(run({}, ctx({ attempt: 3 }))).rejects.toThrow('secret detail');
    await expect(run({}, ctx({ attempt: 4 }))).rejects.toThrow('secret detail');
    expect(events(logger)).toEqual(['info jobs.started', 'warn jobs.retrying', 'info jobs.started', 'error jobs.failed']);
  });

  it('says why a run failed: the class of the error and its message, cut and with control characters taken out, on both the retry and the final failure', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    class QuotaError extends Error { constructor(m: string) { super(m); this.name = 'QuotaError'; } }
    const failing = (e: unknown) => instrument('purge', () => Promise.reject(e), deps.log, clock);
    await expect(failing(new QuotaError('no space\nleft'))({}, ctx({ attempt: 1 }))).rejects.toThrow();
    await expect(failing(new TypeError('x'.repeat(500)))({}, ctx({ attempt: 4 }))).rejects.toThrow();
    await expect(failing('just a string')({}, ctx({ attempt: 2 }))).rejects.toBe('just a string');
    const failures = logger.entries.filter((e) => e.event === 'jobs.retrying' || e.event === 'jobs.failed');
    expect(failures.map((e) => [e.event, (e.fields as { errorName: string }).errorName, (e.fields as { errorMessage: string }).errorMessage])).toEqual([
      ['jobs.retrying', 'QuotaError', 'no space left'],
      ['jobs.failed', 'TypeError', 'x'.repeat(200)],
      ['jobs.retrying', 'NonError', 'just a string'],
    ]);
    expect(failures[0]?.fields).toMatchObject({ name: 'purge', jobId: 'j1', attempt: 1 });
  });

  it('never throws while describing a failure, whatever was thrown, so the original error is the one that reaches pg-boss and the log line is written', async () => {
    const hostile = [
      Object.assign(new Error('x'), { message: undefined }), Object.assign(new Error('x'), { name: 42 }), Object.create(null) as unknown, { toString() { throw new Error('no'); } }, null, undefined, 7,
    ];
    for (const thrown of hostile) {
      const { deps, logger, clock } = fakeJobDeps();
      await expect(instrument('purge', () => Promise.reject(thrown), deps.log, clock)({}, ctx())).rejects.toBe(thrown);
      expect(logger.entries.map((e) => e.event)).toEqual(['jobs.started', 'jobs.retrying']);
      const fields = logger.entries[1]?.fields as { errorName: string; errorMessage: string };
      expect(typeof fields.errorName).toBe('string');
      expect(typeof fields.errorMessage).toBe('string');
    }
  });

  it('treats a missing message as empty, so the code is used, and survives a getter that throws', () => {
    expect(reasonOf(Object.assign(new Error('x'), { message: undefined, code: 'ECONNRESET' }))).toEqual({ errorName: 'Error', errorCode: 'ECONNRESET', errorMessage: 'ECONNRESET' });
    expect(reasonOf(new AggregateError([{ code: 'ECONNREFUSED' }], ''))).toEqual({ errorName: 'AggregateError', errorCode: 'ECONNREFUSED', errorMessage: 'ECONNREFUSED' });
    expect(reasonOf(new AggregateError([null], ''))).toEqual({ errorName: 'AggregateError', errorMessage: '' });
    for (const key of ['message', 'name', 'errors', 'code']) {
      const bad = new Error('boom');
      Object.defineProperty(bad, key, { get() { throw new Error('getter'); } });
      const r = reasonOf(bad);
      expect([typeof r.errorName, typeof r.errorMessage]).toEqual(['string', 'string']);
    }
    expect(reasonOf(new Proxy(new Error('p'), { get() { throw new Error('trap'); } }))).toEqual({ errorName: 'Error', errorMessage: '' });
  });

  it('says what a connection error with no message of its own was: the first error inside it, or its code', () => {
    const refused = new AggregateError([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }), new Error('second')], '');
    expect(reasonOf(refused)).toEqual({ errorName: 'AggregateError', errorCode: 'ECONNREFUSED', errorMessage: 'connect ECONNREFUSED 127.0.0.1:5432' });
    expect(reasonOf(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toEqual({ errorName: 'Error', errorCode: 'ECONNRESET', errorMessage: 'ECONNRESET' });
    expect(reasonOf(new AggregateError([], ''))).toEqual({ errorName: 'AggregateError', errorMessage: '' });
    expect(reasonOf(new Error('has its own message', { cause: 'x' }))).toEqual({ errorName: 'Error', errorMessage: 'has its own message' });
  });

  describe('a reason that is safe to log: the class, the code, and a message with its values taken out', () => {
    const said = (message: string, extra: Record<string, unknown> = {}) => reasonOf(Object.assign(new Error(message), extra));

    it('replaces quoted literals, whatever the quote, with a placeholder (a pg message echoes the value that was refused)', () => {
      expect(said('invalid input syntax for type uuid: "T-secret-123"').errorMessage).toBe('invalid input syntax for type uuid: <value>');
      expect(said("cannot import 'My Secret Page.md' into a full collection").errorMessage).toBe('cannot import <value> into a full collection');
      expect(said('bad name `private notes` and "second one"').errorMessage).toBe('bad name <value> and <value>');
      expect(said('invalid input syntax for type integer: "unterminated secret').errorMessage).toBe('invalid input syntax for type integer: <value>');
      expect(said("it isn't the user's page").errorMessage).toBe("it isn't the user's page"); // an apostrophe in a word is not a quote
    });

    it('replaces URLs, with their credentials, and email-like tokens', () => {
      const url = ['post', 'gres://', 'app', ':', 'not-a-password', '@db.internal:5432/grimoire'].join(''); // built here: no credentialed URL literal in a test file
      expect(said(`connect failed for ${url} (timeout)`).errorMessage).toBe('connect failed for <url> (timeout)');
      expect(said('GET https://files.example.com/a/b?sig=abc123 returned 403').errorMessage).toBe('GET <url> returned 403');
      expect(said('user alice.smith+tag@example.com is not a member').errorMessage).toBe('user <email> is not a member');
    });

    it('keeps what is not a value: the rule that was broken and its type', () => {
      expect(said('value too long for type character varying(10)').errorMessage).toBe('value too long for type character varying(10)');
      expect(said('duplicate key value violates unique constraint pages_pkey').errorMessage).toBe('duplicate key value violates unique constraint pages_pkey');
    });

    it('redacts before it cuts, so a value that straddles the limit is not half shown', () => {
      const r = said(`${'x'.repeat(190)} "a very secret value indeed"`);
      expect(r.errorMessage).toBe(`${'x'.repeat(190)} <value>`);
      expect(said(`${'y'.repeat(300)}`).errorMessage).toHaveLength(200);
    });

    it('gives the SQLSTATE or the errno when there is one, and nothing for a code that is not one', () => {
      expect(said('invalid input', { code: '22P02' }).errorCode).toBe('22P02');
      expect(said('connect', { code: 'ECONNREFUSED' }).errorCode).toBe('ECONNREFUSED');
      expect(said('a', { code: 'has spaces and a "value"' }).errorCode).toBeUndefined();
      expect(said('a', { code: 42 }).errorCode).toBeUndefined();
      expect('errorCode' in said('no code')).toBe(false);
      expect(reasonOf(new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })], '')).errorCode).toBe('ECONNREFUSED');
    });

    it('writes the code and the redacted message in the log lines, and nothing of the value', async () => {
      const { deps, logger, clock } = fakeJobDeps();
      const error = Object.assign(new Error('invalid input syntax for type uuid: "T-secret-123"'), { code: '22P02' });
      await expect(instrument('purge', () => Promise.reject(error), deps.log, clock)({}, ctx())).rejects.toBe(error);
      expect(logger.entries[1]?.fields).toMatchObject({ errorName: 'Error', errorCode: '22P02', errorMessage: 'invalid input syntax for type uuid: <value>' });
      expect(JSON.stringify(logger.entries)).not.toContain('T-secret-123');
    });
  });

  it('does not log the payload of the job', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    await expect(instrument('purge', () => Promise.reject(new Error('boom')), deps.log, clock)({ tenantId: 'T-secret-tenant' }, ctx())).rejects.toThrow();
    expect(JSON.stringify(logger.entries)).not.toContain('T-secret-tenant');
  });

  it('logs jobs.aborted when the handler returns after its signal aborted', async () => {
    const { deps, logger, clock } = fakeJobDeps();
    const stop = new AbortController();
    await instrument('import', async () => { stop.abort(); }, deps.log, clock)({}, ctx({ signal: stop.signal }));
    expect(events(logger)).toEqual(['info jobs.started', 'warn jobs.aborted', 'info jobs.completed']);
  });
});
