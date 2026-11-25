import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** One file of `models/models.lock.json` for the model in use. */
export interface LockedFile {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

/** The lock's entries of one model; `weights` is the file whose first 8 hex digits tell one build of the model from another. */
export interface ModelFiles {
  readonly weights: LockedFile;
  readonly tokenizer: LockedFile;
}

/** The files of `model` in the lock text, or undefined when the lock is not readable as one or does not hold the two files. */
export function parseLock(text: string, model: string): ModelFiles | undefined {
  let lock: { files?: { model?: unknown; name?: unknown; sha256?: unknown; size?: unknown }[] };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    return undefined;
  }
  const pick = (name: string): LockedFile | undefined => {
    const f = (lock.files ?? []).find((entry) => entry.model === model && entry.name === name);
    return f !== undefined && typeof f.sha256 === 'string' && typeof f.size === 'number' ? { name, sha256: f.sha256, size: f.size } : undefined;
  };
  const weights = pick('model_quantized.onnx');
  const tokenizer = pick('tokenizer.json');
  return weights === undefined || tokenizer === undefined ? undefined : { weights, tokenizer };
}

export async function readLock(file: string, model: string): Promise<ModelFiles | undefined> {
  try {
    return parseLock(await readFile(file, 'utf8'), model);
  } catch {
    return undefined;
  }
}

/** What tells one build of the weights from another: with the model's name it is the `model` column of the stored chunks, so new weights re-embed every page. */
export const versionOf = (files: ModelFiles | undefined): string => `int8@${files === undefined ? 'unknown' : files.weights.sha256.slice(0, 8)}`;

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export type Verified = { readonly ok: true; readonly weights: string; readonly tokenizer: string } | { readonly ok: false; readonly reason: 'model-missing' | 'model-hash-mismatch' };

/**
 * Every file of the model is in `<modelDir>/<model>/`, has the size of the lock and the SHA-256 of the lock. A file that is not there is `model-missing`; one that is there and is not the
 * locked file (a flipped byte, another size) is `model-hash-mismatch`. Nothing is read from anywhere else and nothing is fetched.
 */
export async function verifyFiles(modelDir: string, model: string, files: ModelFiles | undefined): Promise<Verified> {
  if (files === undefined) return { ok: false, reason: 'model-missing' };
  const paths: string[] = [];
  for (const locked of [files.weights, files.tokenizer]) {
    const file = path.join(modelDir, model, locked.name);
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) return { ok: false, reason: 'model-missing' };
    if (info.size !== locked.size) return { ok: false, reason: 'model-hash-mismatch' };
    const sha = await sha256Of(file).catch(() => undefined);
    if (sha === undefined) return { ok: false, reason: 'model-missing' }; // there but not readable
    if (sha !== locked.sha256) return { ok: false, reason: 'model-hash-mismatch' };
    paths.push(file);
  }
  return { ok: true, weights: paths[0] as string, tokenizer: paths[1] as string };
}
