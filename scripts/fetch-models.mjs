#!/usr/bin/env node
// Fetches the model files of the embedder (M7-T12) named in models/models.lock.json, and checks them.
//
//   node scripts/fetch-models.mjs [--lock FILE] [--out DIR]    download what is missing or is not the locked file, verify every file
//   node scripts/fetch-models.mjs --verify [--lock FILE] [--out DIR]    only check the files that are there (no network); fail for a missing or changed one
//
// Exit 0 when every file is the locked one, 1 when a file is missing (with --verify), has another SHA-256 or size, or was reached by a redirect to a host the lock does not allow, 2 on a lock that is
// not usable. The only network use of the whole model path is here, at image build time: the embedder itself loads from a directory and makes no call.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const lockFile = path.resolve(opt('--lock') ?? path.join(root, 'models/models.lock.json'));
const outDir = path.resolve(opt('--out') ?? path.join(root, 'models'));
const verifyOnly = args.includes('--verify');
const MAX_REDIRECTS = 5;

function usage(message) {
  console.error(`fetch-models: ${message}`);
  process.exit(2);
}

/** The lock, checked: every entry names a model and a file that stay inside the directory, a commit, an address, a SHA-256 and a size. */
function readLock(text) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    return usage(`the lock is not JSON (${error.message})`);
  }
  if (!Array.isArray(lock.files) || lock.files.length === 0) return usage('the lock has no files');
  const hosts = Array.isArray(lock.redirectHosts) ? lock.redirectHosts : [];
  const part = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  for (const [n, f] of lock.files.entries()) {
    const say = (key) => usage(`file ${String(n)}: ${key} is missing or not valid`);
    if (typeof f.model !== 'string' || !part.test(f.model)) say('model');
    if (typeof f.name !== 'string' || !part.test(f.name)) say('name');
    if (typeof f.revision !== 'string' || !/^[0-9a-f]{40}$/.test(f.revision)) say('revision');
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) say('sha256');
    if (!Number.isSafeInteger(f.size) || f.size <= 0) say('size');
    try {
      new URL(f.url);
    } catch {
      say('url');
    }
  }
  return { files: lock.files, hosts };
}

const allowedHost = (host, base, hosts) => host === base || hosts.some((h) => host === h || host.endsWith(`.${h}`));

async function digest(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Why a file on disk is not the locked one, or undefined when it is. */
async function problem(file, entry) {
  if (!existsSync(file)) return 'it is missing';
  if (statSync(file).size !== entry.size) return `its size is ${String(statSync(file).size)}, the lock says ${String(entry.size)}`;
  const sha = await digest(file);
  return sha === entry.sha256 ? undefined : `its sha256 is ${sha}, the lock says ${entry.sha256}`;
}

/** Downloads one file to `<file>.part`, following a redirect only to the host of the address or to one of the lock's `redirectHosts`, and stops as soon as it is larger than the lock says. */
async function download(entry, hosts, part) {
  let url = new URL(entry.url);
  const base = url.hostname;
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'grimoire-fetch-models' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null || hop >= MAX_REDIRECTS) throw new Error('too many redirects, or one with no address');
      url = new URL(location, url);
      if (!allowedHost(url.hostname, base, hosts)) throw new Error(`redirect to another host (${url.hostname}), which the lock does not allow`);
      continue;
    }
    if (!response.ok || response.body === null) throw new Error(`the server answered ${String(response.status)}`);
    const hash = createHash('sha256');
    let size = 0;
    const counted = Readable.fromWeb(response.body);
    counted.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
      if (size > entry.size) counted.destroy(new Error(`size: more than the ${String(entry.size)} bytes of the lock`));
    });
    await pipeline(counted, createWriteStream(part));
    if (size !== entry.size) throw new Error(`size: ${String(size)} bytes, the lock says ${String(entry.size)}`);
    const sha = hash.digest('hex');
    if (sha !== entry.sha256) throw new Error(`sha256: ${sha}, the lock says ${entry.sha256}`);
    return;
  }
}

const { files, hosts } = readLock(await readFile(lockFile, 'utf8'));
let failed = false;
for (const entry of files) {
  const label = `${entry.model}/${entry.name}`;
  const file = path.join(outDir, entry.model, entry.name);
  const wrong = await problem(file, entry);
  if (wrong === undefined) {
    console.log(`${label}: already there, as locked`);
    continue;
  }
  if (verifyOnly) {
    console.error(`${label}: ${wrong} (sha256 and size are checked against ${path.basename(lockFile)})`);
    failed = true;
    continue;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  try {
    await download(entry, hosts, part);
    renameSync(part, file);
    console.log(`${label}: downloaded and verified (${String(entry.size)} bytes)`);
  } catch (error) {
    rmSync(part, { force: true });
    console.error(`${label}: ${error.cause?.message ?? error.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
