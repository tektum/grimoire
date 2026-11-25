import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseLock, readLock, verifyFiles, versionOf } from '../src/lock.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const weights = Buffer.from('the weights');
const tokenizer = Buffer.from('{"the":"tokenizer"}');
const lockText = JSON.stringify({
  files: [
    { model: 'm', name: 'model_quantized.onnx', sha256: sha(weights), size: weights.length },
    { model: 'm', name: 'tokenizer.json', sha256: sha(tokenizer), size: tokenizer.length },
    { model: 'other', name: 'tokenizer.json', sha256: 'f'.repeat(64), size: 1 },
  ],
});
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function modelDir(files: Record<string, Buffer> = { 'model_quantized.onnx': weights, 'tokenizer.json': tokenizer }): string {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-lock-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'm'));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(dir, 'm', name), bytes);
  return dir;
}

describe('the lock', () => {
  it('names the weights and the tokenizer of a model, and the version is the start of the weights hash', () => {
    const files = parseLock(lockText, 'm');
    expect(files?.weights).toEqual({ name: 'model_quantized.onnx', sha256: sha(weights), size: weights.length });
    expect(versionOf(files)).toBe(`int8@${sha(weights).slice(0, 8)}`);
    expect(versionOf(undefined)).toBe('int8@unknown');
  });

  it('is nothing when it is not JSON, lacks the model, or an entry is not shaped', () => {
    expect(parseLock('not json', 'm')).toBeUndefined();
    expect(parseLock(lockText, 'absent')).toBeUndefined();
    expect(parseLock('{}', 'm')).toBeUndefined();
    expect(parseLock(JSON.stringify({ files: [{ model: 'm', name: 'model_quantized.onnx', sha256: 1, size: 'x' }] }), 'm')).toBeUndefined();
  });

  it('is read from a file, and a file that is not there is nothing', async () => {
    const dir = modelDir();
    writeFileSync(path.join(dir, 'models.lock.json'), lockText);
    expect((await readLock(path.join(dir, 'models.lock.json'), 'm'))?.tokenizer.name).toBe('tokenizer.json');
    expect(await readLock(path.join(dir, 'nope.json'), 'm')).toBeUndefined();
  });
});

describe('verifyFiles', () => {
  const files = parseLock(lockText, 'm');

  it('accepts a directory whose files have the locked size and SHA-256 and gives their paths', async () => {
    const dir = modelDir();
    expect(await verifyFiles(dir, 'm', files)).toEqual({ ok: true, weights: path.join(dir, 'm', 'model_quantized.onnx'), tokenizer: path.join(dir, 'm', 'tokenizer.json') });
  });

  it('is model-missing for no lock, a file that is not there, one that is not a file, and one that cannot be read', async () => {
    expect(await verifyFiles(modelDir(), 'm', undefined)).toEqual({ ok: false, reason: 'model-missing' });
    expect(await verifyFiles(modelDir({ 'tokenizer.json': tokenizer }), 'm', files)).toEqual({ ok: false, reason: 'model-missing' });
    const dir = modelDir();
    rmSync(path.join(dir, 'm', 'tokenizer.json'));
    mkdirSync(path.join(dir, 'm', 'tokenizer.json'));
    expect(await verifyFiles(dir, 'm', files)).toEqual({ ok: false, reason: 'model-missing' });
    if (process.getuid?.() !== 0) {
      const locked = modelDir();
      chmodSync(path.join(locked, 'm', 'tokenizer.json'), 0o000);
      expect(await verifyFiles(locked, 'm', files)).toEqual({ ok: false, reason: 'model-missing' });
    }
  });

  it('is model-hash-mismatch for a byte flipped and for another size, and does not look at later files then', async () => {
    const flipped = Buffer.from(weights);
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(await verifyFiles(modelDir({ 'model_quantized.onnx': flipped, 'tokenizer.json': tokenizer }), 'm', files)).toEqual({ ok: false, reason: 'model-hash-mismatch' });
    expect(await verifyFiles(modelDir({ 'model_quantized.onnx': Buffer.concat([weights, Buffer.from('x')]), 'tokenizer.json': tokenizer }), 'm', files)).toEqual({ ok: false, reason: 'model-hash-mismatch' });
    expect(await verifyFiles(modelDir({ 'model_quantized.onnx': weights, 'tokenizer.json': Buffer.from('{"the":"tokenizeR"}') }), 'm', files)).toEqual({ ok: false, reason: 'model-hash-mismatch' });
  });
});
