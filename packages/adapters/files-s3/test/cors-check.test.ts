import { describe, expect, it } from 'vitest';
import { checkCors, corsProbeUrl, type EnsureBucketOptions } from '../src/index.js';
import { bucket, config, recorder, useRecordingServer, type Reply, type Seen } from './recording-server.js';

useRecordingServer();

const ONE = 'https://one.example.test';
const TWO = 'https://two.example.test';
const options = (over: Partial<EnsureBucketOptions> = {}): EnsureBucketOptions => ({
  endpoint: recorder.origin,
  bucket,
  region: 'us-east-1',
  addressing: 'path',
  accessKey: config().accessKey,
  secretKey: config().secretKey,
  allowedOrigins: [ONE, TWO],
  ...over,
});

/** What a store whose rule allows these origins, methods and headers answers to a preflight. */
const allowing =
  (origins: string[], methods: string, headers: string) =>
  (request: Seen): Reply => {
    const origin = String(request.headers.origin);
    if (!origins.includes(origin)) return { status: 403 };
    return {
      status: 200,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': methods,
        'access-control-allow-headers': headers,
      },
    };
  };
const FULL = 'content-type, content-disposition, if-none-match, x-amz-*';

describe('checkCors', () => {
  it('asks, for each origin, about PUT with its three headers, then GET, then HEAD, and writes nothing', async () => {
    recorder.respond = allowing([ONE, TWO], 'GET, PUT, HEAD', FULL);
    expect(await checkCors(options())).toEqual({ ok: true });
    expect(recorder.seen.map((r) => r.method)).toEqual(Array(6).fill('OPTIONS'));
    expect(recorder.seen.map((r) => [r.headers.origin, r.headers['access-control-request-method']])).toEqual([
      [ONE, 'PUT'],
      [ONE, 'GET'],
      [ONE, 'HEAD'],
      [TWO, 'PUT'],
      [TWO, 'GET'],
      [TWO, 'HEAD'],
    ]);
    expect(recorder.seen[0]?.headers['access-control-request-headers']).toBe(
      'content-type,content-disposition,if-none-match',
    );
    expect(recorder.seen[1]?.headers['access-control-request-headers']).toBeUndefined();
    expect(recorder.seen[0]?.path).toBe(`/${bucket}/attachments/cors-probe`);
    expect(Object.keys(recorder.seen[0]?.headers ?? {})).not.toContain('authorization');
  });

  it('accepts a rule that allows everything with a star', async () => {
    recorder.respond = () => ({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': '*',
        'access-control-allow-headers': '*',
      },
    });
    expect(await checkCors(options())).toEqual({ ok: true });
  });

  it('names the first origin the store does not allow', async () => {
    recorder.respond = allowing([ONE], 'GET, PUT, HEAD', FULL);
    expect(await checkCors(options())).toEqual({ ok: false, problem: `origin ${TWO} is not allowed` });
    recorder.respond = () => ({
      status: 200,
      headers: { 'access-control-allow-origin': 'https://elsewhere.example.test' },
    });
    expect(await checkCors(options())).toEqual({ ok: false, problem: `origin ${ONE} is not allowed` });
  });

  it('names a method the rule leaves out', async () => {
    recorder.respond = allowing([ONE, TWO], 'GET, PUT', FULL);
    expect(await checkCors(options())).toEqual({ ok: false, problem: `method HEAD is not allowed for origin ${ONE}` });
    recorder.respond = allowing([ONE, TWO], 'GET, HEAD', FULL);
    expect(await checkCors(options())).toEqual({ ok: false, problem: `method PUT is not allowed for origin ${ONE}` });
  });

  it('names the first header the rule leaves out, the create-only header of the setting included', async () => {
    recorder.respond = allowing([ONE, TWO], 'GET, PUT, HEAD', 'content-disposition, if-none-match');
    expect(await checkCors(options())).toEqual({
      ok: false,
      problem: `header content-type is not allowed for origin ${ONE}`,
    });
    recorder.respond = allowing([ONE, TWO], 'GET, PUT, HEAD', 'content-type, content-disposition');
    expect(await checkCors(options())).toEqual({
      ok: false,
      problem: `header if-none-match is not allowed for origin ${ONE}`,
    });
    const header = 'x-create-header';
    recorder.respond = allowing([ONE, TWO], 'GET, PUT, HEAD', 'content-type, content-disposition, if-none-match');
    expect(await checkCors(options({ createOnlyHeader: header }))).toEqual({
      ok: false,
      problem: `header ${header} is not allowed for origin ${ONE}`,
    });
    recorder.respond = allowing([ONE, TWO], 'GET, PUT, HEAD', `content-type, content-disposition, ${header}`);
    expect(await checkCors(options({ createOnlyHeader: header }))).toEqual({ ok: true });
  });

  it('is unavailable when the store cannot be reached', async () => {
    await expect(checkCors(options({ endpoint: 'http://127.0.0.1:1' }))).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('where and how long checkCors asks', () => {
  it('asks the public endpoint, not the internal one, and keeps its path prefix', async () => {
    recorder.respond = allowing([ONE, TWO], 'GET, PUT, HEAD', FULL);
    expect(
      await checkCors(options({ endpoint: 'http://127.0.0.1:1', publicEndpoint: `${recorder.origin}/files/` })),
    ).toEqual({
      ok: true,
    });
    expect(recorder.seen[0]?.path).toBe(`/files/${bucket}/attachments/cors-probe`);
  });

  it('gives up on a store that accepts the request and never answers, as unavailable', async () => {
    recorder.hang = true;
    await expect(checkCors(options({ timeoutMs: 200, allowedOrigins: [ONE] }))).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});

describe('corsProbeUrl', () => {
  it('puts the bucket in the path, or in the host for virtual addressing', () => {
    const base = options({ endpoint: 'http://store.example.test:8333' });
    expect(corsProbeUrl(base)).toBe(`http://store.example.test:8333/${bucket}/attachments/cors-probe`);
    expect(corsProbeUrl({ ...base, addressing: 'virtual' })).toBe(
      `http://${bucket}.store.example.test:8333/attachments/cors-probe`,
    );
    const prefixed = { ...base, publicEndpoint: 'https://files.example.test/files' };
    expect(corsProbeUrl(prefixed)).toBe(`https://files.example.test/files/${bucket}/attachments/cors-probe`);
    expect(corsProbeUrl({ ...prefixed, addressing: 'virtual' })).toBe(
      `https://${bucket}.files.example.test/files/attachments/cors-probe`,
    );
  });
});
