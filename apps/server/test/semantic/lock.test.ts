import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

// The model files of the embedder (M7-T12): the lock names each by a pinned revision, URL, SHA-256 and size, and `scripts/fetch-models.mjs` downloads them and refuses anything that is not that file.
const root = path.resolve(import.meta.dirname, '../../../..');
const script = path.join(root, 'scripts/fetch-models.mjs');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('models/models.lock.json', () => {
  const lock = JSON.parse(readFileSync(path.join(root, 'models/models.lock.json'), 'utf8')) as {
    files: { model: string; name: string; revision: string; url: string; sha256: string; size: number }[];
    redirectHosts: string[];
  };

  it('names the model file and the tokenizer of both models, each at a pinned commit with its URL, SHA-256 and size', () => {
    expect(lock.files.map((f) => `${f.model}/${f.name}`).sort()).toEqual([
      'multilingual-e5-base/model_quantized.onnx',
      'multilingual-e5-base/tokenizer.json',
      'multilingual-e5-small/model_quantized.onnx',
      'multilingual-e5-small/tokenizer.json',
    ]);
    for (const f of lock.files) {
      expect(f.revision, f.name).toMatch(/^[0-9a-f]{40}$/);
      expect(f.sha256, f.name).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(f.size) && f.size > 0, f.name).toBe(true);
      expect(f.url, 'the URL carries the commit, not a branch').toContain(`/resolve/${f.revision}/`);
      expect(new URL(f.url).protocol).toBe('https:');
      expect(lock.redirectHosts).toContain(new URL(f.url).hostname);
    }
  });

  it('is the only thing committed under models/, with the ignore file: the weights are never in the repository', () => {
    expect(execFileSync('git', ['ls-files', 'models'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).sort()).toEqual(['models/.gitignore', 'models/models.lock.json']);
  });
});

describe('scripts/fetch-models.mjs', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  /** A server for fixture files (`/ok`, `/short`, `/long`, `/other-bytes`, `/hop` redirecting to the same host, `/away` redirecting to another host name) and a lock that names them. */
  async function setup(files: { name: string; body: Buffer; claim?: { sha256?: string; size?: number } }[]): Promise<{ lock: string; out: string; port: number }> {
    const bodies = new Map(files.map((f) => [`/${f.name}`, f.body]));
    const server: Server = createServer((req, res) => {
      // The addresses of a lock name the commit (`/resolve/<revision>/<file>`, as the real ones do): the fixture server answers for the file under it.
      const url = (req.url ?? '/').replace(/^\/resolve\/a{40}/, '');
      if (url.startsWith('/hop/')) return void res.writeHead(302, { location: `/${url.slice(5)}` }).end();
      if (url.startsWith('/away/')) return void res.writeHead(302, { location: `http://localhost:${String((server.address() as AddressInfo).port)}/${url.slice(6)}` }).end();
      const body = bodies.get(url);
      if (body === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-models-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const lock = path.join(dir, 'lock.json');
    writeFileSync(
      lock,
      JSON.stringify({
        redirectHosts: ['127.0.0.1'],
        files: files.map((f) => ({
          model: 'm',
          name: f.name,
          revision: 'a'.repeat(40),
          url: `http://127.0.0.1:${String(port)}/resolve/${'a'.repeat(40)}/${f.name}`,
          sha256: f.claim?.sha256 ?? sha(f.body),
          size: f.claim?.size ?? f.body.length,
        })),
      }),
    );
    return { lock, out: path.join(dir, 'models'), port };
  }
  // Asynchronously: the fixture server lives in this process, and a synchronous wait would stop it from answering.
  const exec = promisify(execFile);
  const run = async (lock: string, out: string, ...more: string[]): Promise<{ status: number; stdout: string; stderr: string }> => {
    try {
      const r = await exec(process.execPath, [script, '--lock', lock, '--out', out, ...more], { encoding: 'utf8' });
      return { status: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { status: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it('downloads each file, checks it, and writes it under <model>/<name>; a second run changes nothing and --verify agrees', async () => {
    const body = Buffer.from('weights of a model, as bytes');
    const s = await setup([{ name: 'ok', body }]);
    const first = await run(s.lock, s.out);
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(path.join(s.out, 'm/ok'))).toEqual(body);
    expect(existsSync(path.join(s.out, 'm/ok.part'))).toBe(false);
    expect((await run(s.lock, s.out)).stdout).toContain('already there');
    expect((await run(s.lock, s.out, '--verify')).status).toBe(0);
  });

  it('fails on a wrong SHA-256, and leaves no file of that name', async () => {
    const s = await setup([{ name: 'bad', body: Buffer.from('some bytes'), claim: { sha256: '0'.repeat(64) } }]);
    const r = await run(s.lock, s.out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sha256');
    expect(existsSync(path.join(s.out, 'm/bad'))).toBe(false);
    expect(existsSync(path.join(s.out, 'm/bad.part'))).toBe(false);
  });

  it.each([
    ['smaller than the lock says', 5],
    ['larger than the lock says', 5000],
  ])('fails on a file %s', async (_name, claimed) => {
    const body = Buffer.from('twelve bytes');
    const s = await setup([{ name: 'size', body, claim: { size: claimed } }]);
    const r = await run(s.lock, s.out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('size');
    expect(existsSync(path.join(s.out, 'm/size'))).toBe(false);
  });

  it('follows a redirect to the same host and refuses one to another host name, whatever the bytes are', async () => {
    const body = Buffer.from('fine bytes');
    const s = await setup([{ name: 'ok', body }]);
    const lock = JSON.parse(readFileSync(s.lock, 'utf8')) as { files: { url: string }[] };
    lock.files[0]!.url = `http://127.0.0.1:${String(s.port)}/resolve/${'a'.repeat(40)}/hop/ok`;
    writeFileSync(s.lock, JSON.stringify(lock));
    expect((await run(s.lock, s.out)).status).toBe(0);
    lock.files[0]!.url = `http://127.0.0.1:${String(s.port)}/resolve/${'a'.repeat(40)}/away/ok`;
    writeFileSync(s.lock, JSON.stringify(lock));
    const away = await run(s.lock, path.join(s.out, '2'));
    expect(away.status).toBe(1);
    expect(away.stderr).toContain('redirect');
    expect(existsSync(path.join(s.out, '2/m/ok'))).toBe(false);
  });

  it('--verify fails for a file that is missing and for one whose bytes changed on disk', async () => {
    const body = Buffer.from('original bytes');
    const s = await setup([{ name: 'ok', body }]);
    expect((await run(s.lock, s.out, '--verify')).status).toBe(1);
    expect((await run(s.lock, s.out)).status).toBe(0);
    writeFileSync(path.join(s.out, 'm/ok'), Buffer.from('flipped bytes!'));
    const r = await run(s.lock, s.out, '--verify');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sha256');
    // A plain run replaces the file that is not the one in the lock.
    expect((await run(s.lock, s.out)).status).toBe(0);
    expect(readFileSync(path.join(s.out, 'm/ok'))).toEqual(body);
  });

  it('refuses a lock whose file names could leave the models directory, or whose entry is incomplete', async () => {
    const s = await setup([{ name: 'ok', body: Buffer.from('x') }]);
    const lock = JSON.parse(readFileSync(s.lock, 'utf8')) as { files: Record<string, unknown>[] };
    for (const [key, value] of [
      ['name', '../escape'],
      ['model', 'a/b'],
      ['sha256', 'abc'],
      ['size', -1],
      ['revision', 'main'],
      ['url', 'https://huggingface.co/Xenova/m/resolve/main/model_quantized.onnx'],
    ] as const) {
      writeFileSync(s.lock, JSON.stringify({ ...lock, files: [{ ...lock.files[0], [key]: value }] }));
      const r = await run(s.lock, s.out);
      expect(r.status, key).toBe(2);
      expect(r.stderr, key).toContain(key);
    }
  });
});
