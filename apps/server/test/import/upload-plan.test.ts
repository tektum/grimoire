import { describe, expect, it } from 'vitest';
import { MAX_PARTS, MIN_PART_BYTES } from '@tektum/grimoire-core/ports/file-storage';
import { DEFAULT_UPLOAD_SIZING, partLength, planUpload } from '../../src/import/upload-plan.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('planUpload', () => {
  it('sends a file under 4 GiB as one signed PUT, and 4 GiB or more in parts of 64 MiB', () => {
    expect(planUpload(1)).toEqual({ kind: 'single' });
    expect(planUpload(4 * GIB - 1)).toEqual({ kind: 'single' });
    expect(planUpload(4 * GIB)).toEqual({ kind: 'multipart', partSize: 64 * MIB, partCount: 64 });
    expect(planUpload(4 * GIB + 1)).toEqual({ kind: 'multipart', partSize: 64 * MIB, partCount: 65 });
    expect(DEFAULT_UPLOAD_SIZING).toEqual({ singleMaxBytes: 4 * GIB, partBytes: 64 * MIB });
  });

  it('raises the part size, in whole MiB, so that the parts never pass the 10,000 a store takes', () => {
    const size = 700 * GIB; // 11,200 parts of 64 MiB
    const plan = planUpload(size);
    if (plan.kind !== 'multipart') throw new Error('expected parts');
    expect(plan.partCount).toBeLessThanOrEqual(MAX_PARTS);
    expect(plan.partSize % MIB).toBe(0);
    expect(plan.partSize).toBeGreaterThan(64 * MIB);
    expect(plan.partCount).toBe(Math.ceil(size / plan.partSize));
    // the part before the last is not the last: it is never under the smallest part a store takes
    expect(plan.partSize).toBeGreaterThanOrEqual(MIN_PART_BYTES);
  });

  it('takes the sizes it is given', () => {
    expect(planUpload(30 * MIB, { singleMaxBytes: 10 * MIB, partBytes: 10 * MIB })).toEqual({ kind: 'multipart', partSize: 10 * MIB, partCount: 3 });
    expect(planUpload(10 * MIB - 1, { singleMaxBytes: 10 * MIB, partBytes: 10 * MIB })).toEqual({ kind: 'single' });
  });
});

describe('partLength', () => {
  it('is the part size for every part but the last, and the rest of the file for the last', () => {
    const size = 2 * 64 * MIB + 5;
    expect([1, 2, 3].map((n) => partLength(size, 64 * MIB, n))).toEqual([64 * MIB, 64 * MIB, 5]);
    expect(partLength(2 * 64 * MIB, 64 * MIB, 2)).toBe(64 * MIB);
  });

  it('adds up to the size of the file', () => {
    const size = 5 * GIB + 12_345;
    const plan = planUpload(size);
    if (plan.kind !== 'multipart') throw new Error('expected parts');
    let sum = 0;
    for (let n = 1; n <= plan.partCount; n += 1) sum += partLength(size, plan.partSize, n);
    expect(sum).toBe(size);
  });
});
