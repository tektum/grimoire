import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import {
  CORPUS_DIR,
  EXPECTED_DIR,
  GROUPS,
  UPDATE,
  assertMatches,
  createHeadless,
  expectedFiles,
  listExpected,
  loadEntries,
  markedDifference,
  observe,
  pipelineOn,
  sharedPipeline,
  writeExpected,
} from './support.js';
import type { Entry, Observed, Pipeline } from './support.js';
import { buildLongPage, describeLongPage } from './long-page.js';

interface KnownException {
  file: string;
  /** Which checks fail today: `meaning` (marked reads input and output differently), `drift`, `refused`. */
  kinds: string[];
  reason: string;
}

const entries = loadEntries();
const exceptions = JSON.parse(readFileSync(join(CORPUS_DIR, 'known-exceptions.json'), 'utf8')) as KnownException[];
const exceptionOf = (entry: Entry): KnownException | undefined => exceptions.find((item) => item.file === `${entry.group}/${entry.name}.md`);

/** What each entry does today, computed once (about 5 s for all of it). */
const observed = new Map<string, Observed>();
const referenceDiff = new Map<string, string | undefined>();
for (const entry of entries) {
  const result = await observe(sharedPipeline, entry.markdown);
  const key = `${entry.group}/${entry.name}`;
  observed.set(key, result);
  const markdownOut = result.first.markdown;
  referenceDiff.set(key, markdownOut === undefined ? undefined : markedDifference(entry.markdown, markdownOut));
}

const filesOf = (entry: Entry): Record<string, string> => {
  const key = `${entry.group}/${entry.name}`;
  return expectedFiles(observed.get(key) as Observed, referenceDiff.get(key));
};

// The long page is generated from a seed: only its hashes and sizes are committed (`long-page.json`).
const longPage = await describeLongPage(sharedPipeline, buildLongPage());

if (UPDATE) {
  writeExpected(new Map(entries.map((entry) => [`${entry.group}/${entry.name}`, filesOf(entry)])));
  writeFileSync(join(CORPUS_DIR, 'long-page.json'), longPage);
}

const meaningKept = (entry: Entry): boolean => {
  const key = `${entry.group}/${entry.name}`;
  return (observed.get(key) as Observed).first.markdown !== undefined && referenceDiff.get(key) === undefined;
};
const kept = (group: string): string => `${entries.filter((entry) => entry.group === group && meaningKept(entry)).length}/${entries.filter((entry) => entry.group === group).length}`;

describe('the reference comparison sees a space at a mark boundary', () => {
  it('"a <em>b</em>" and "a<em>b</em>" differ; extra spaces, and spaces beside a line break, do not', () => {
    expect(markedDifference('a <em>b</em>\n', 'a<em>b</em>\n')).toBeDefined();
    expect(markedDifference('a <em>b</em>\n', 'a   <em>b</em>\n')).toBeUndefined();
    expect(markedDifference('c  \nd\n', 'c\\\nd\n')).toBeUndefined();
    expect(markedDifference('c <br>d\n', 'c<br>d\n')).toBeUndefined();
    expect(markedDifference('a` `b\n', 'a`  `b\n')).toBeDefined(); // code of one space and of two spaces differ
    expect(markedDifference('a\u00A0b\n', 'a b\n')).toBeDefined(); // a non-breaking space is not a space
  });
});

describe('corpus: what is in it', () => {
  it('has no real-document group here (it is not distributed), 33 gfm files and at most 40 own CommonMark cases', () => {
    expect(entries.filter((entry) => entry.group === 'real')).toHaveLength(0);
    expect(entries.filter((entry) => entry.group === 'gfm')).toHaveLength(33);
    const own = entries.filter((entry) => entry.group === 'commonmark').length;
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThanOrEqual(40);
  });

  it('has an entry for every group and a note for every own entry', () => {
    for (const group of GROUPS.filter((g) => g !== 'real')) expect(entries.some((entry) => entry.group === group)).toBe(true);
    for (const entry of entries.filter((item) => item.group !== 'real' && item.group !== 'gfm')) {
      expect(entry.annotation?.note, `${entry.group}/${entry.name} needs a note in own/manifest.json`).toBeTruthy();
    }
  });

  it('has at most 10 known exceptions, each naming a spike file and a reason', () => {
    expect(exceptions.length).toBeLessThanOrEqual(10);
    for (const item of exceptions) {
      expect(item.reason.trim()).not.toBe('');
      expect(item.kinds.length).toBeGreaterThan(0);
      expect(entries.some((entry) => `${entry.group}/${entry.name}.md` === item.file && (entry.group === 'real' || entry.group === 'gfm'))).toBe(true);
    }
  });

  it('has no expected file that no entry owns', () => {
    const owned = entries.flatMap((entry) => Object.keys(filesOf(entry)).map((suffix) => `${entry.group}/${entry.name}.${suffix}`));
    expect(listExpected()).toEqual(owned.sort());
  });
});

describe('corpus: every entry', () => {
  describe.each(entries.map((entry) => [`${entry.group}/${entry.name}`, entry] as const))('%s', (key, entry) => {
    it('outcome, Markdown and search text equal the committed files', () => {
      for (const [suffix, content] of Object.entries(filesOf(entry))) assertMatches(join(EXPECTED_DIR, `${key}.${suffix}`), content);
    });

    it('a refusal is named in the manifest or the exceptions', () => {
      const result = observed.get(key) as Observed;
      if (result.first.markdown !== undefined) return;
      const named = entry.annotation?.finding !== undefined || exceptionOf(entry)?.kinds.includes('refused') === true;
      expect(named, `${key} is refused (${result.first.outcome}) and nothing names it`).toBe(true);
    });

    it('the second save is identical, or the drift is named', () => {
      const result = observed.get(key) as Observed;
      if (result.first.markdown === undefined) return;
      const named = entry.annotation?.drift !== undefined || exceptionOf(entry)?.kinds.includes('drift') === true;
      if (result.stable) {
        expect(named, `${key} is stable but names a drift: remove it`).toBe(false);
      } else {
        expect(named, `${key} drifts on the second save and nothing names it`).toBe(true);
        // A named drift settles: the third save equals the second.
        expect(result.second?.markdown, `${key}: the second save was refused`).toBeDefined();
        expect(result.third?.markdown, `${key}: not stable on a third pass`).toBe(result.second?.markdown);
      }
    });

    it('marked reads the input and the saved Markdown the same, or the difference is named', () => {
      const result = observed.get(key) as Observed;
      if (result.first.markdown === undefined) return;
      const differs = referenceDiff.get(key) !== undefined;
      const named = entry.annotation?.markedDiff !== undefined || exceptionOf(entry)?.kinds.includes('meaning') === true;
      expect(named, differs ? `${key}: marked reads input and output differently and nothing names it` : `${key} names a difference that is gone: remove it`).toBe(differs);
    });
  });
});

describe('corpus: counts and the proof note', () => {
  const note = readFileSync(join(CORPUS_DIR, '../../../../../docs/proof/m2-corpus.md'), 'utf8');

  // The contract floor is 12 of 14 (the spike); the run measures 12 (the two that differ only in how a link and a strong
  // are nested, which the reference renderer sees and a reader does not). The second check pins the measured value:
  // the count may rise, never fall.
  it.skip('the real files keep their meaning in at least 12 of 14 (contract floor; skipped here: that group is not distributed)', () => {
    const count = entries.filter((entry) => entry.group === 'real' && meaningKept(entry)).length;
    expect(count).toBeGreaterThanOrEqual(12);
  });

  it.skip('the count of real files that keep their meaning never drops below the measured 12 (skipped here: that group is not distributed)', () => {
    const count = entries.filter((entry) => entry.group === 'real' && meaningKept(entry)).length;
    expect(count).toBeGreaterThanOrEqual(12);
    expect(entries.filter((entry) => entry.group === 'real').length).toBe(14);
  });

  it('the proof note states the counts the run measures', () => {
    expect(note).toContain(`real-meaning-kept: ${kept('real')}`);
    expect(note).toContain(`gfm-meaning-kept: ${kept('gfm')}`);
    expect(note).toContain(`commonmark-meaning-kept: ${kept('commonmark')}`);
  });

  it('every spike file outside the known exceptions is converted, stable on a second save and read the same by marked', () => {
    for (const entry of entries.filter((item) => item.group === 'real' || item.group === 'gfm')) {
      if (exceptionOf(entry) !== undefined) continue;
      const result = observed.get(`${entry.group}/${entry.name}`) as Observed;
      expect(result.first.outcome, `${entry.group}/${entry.name}`).toBe('converted');
      expect(result.stable, `${entry.group}/${entry.name} second save`).toBe(true);
    }
  });

  it('a listed exception still fails in exactly the way it lists', () => {
    for (const item of exceptions) {
      const entry = entries.find((candidate) => `${candidate.group}/${candidate.name}.md` === item.file) as Entry;
      const result = observed.get(`${entry.group}/${entry.name}`) as Observed;
      const actual = [
        ...(result.first.markdown === undefined ? ['refused'] : []),
        ...(result.first.markdown !== undefined && !result.stable ? ['drift'] : []),
        ...(result.first.markdown !== undefined && referenceDiff.get(`${entry.group}/${entry.name}`) !== undefined ? ['meaning'] : []),
      ];
      expect(actual.sort(), `${item.file} now passes or fails differently: update known-exceptions.json`).toEqual([...item.kinds].sort());
    }
  });
});

describe('corpus: a page near the size cap', () => {
  it('converts as recorded in long-page.json (hashes and sizes only)', () => {
    assertMatches(join(CORPUS_DIR, 'long-page.json'), longPage);
  });
});

describe('corpus: regeneration is deliberate', () => {
  it('a changed output fails, and so does a missing file, unless CORPUS_UPDATE=1 was given', () => {
    const [first] = entries;
    const files = filesOf(first as Entry);
    const path = join(EXPECTED_DIR, `${first?.group}/${first?.name}.out.md`);
    expect(() => assertMatches(path, `${files['out.md']}changed\n`)).toThrow();
    expect(() => assertMatches(path, files['out.md'] ?? '', () => undefined)).toThrow(/CORPUS_UPDATE=1/);
    expect(() => assertMatches(path, files['out.md'] ?? '', () => files['out.md'])).not.toThrow();
    // Running without the flag never writes: the flag is the only switch.
    expect(UPDATE).toBe(process.env['CORPUS_UPDATE'] === '1');
  });

  it('a different input changes the committed files of an entry', async () => {
    const entry = entries.find((item) => item.group === 'commonmark') as Entry;
    const changed = await observe(sharedPipeline, entry.markdown.replace(/\*/g, '_').replace('One', 'Changed'));
    const same = filesOf(entry);
    expect(expectedFiles(changed, undefined)['out.md']).not.toBe(same['out.md']);
  });
});

describe('corpus: the substitute plugin set', () => {
  /** The plain commonmark and gfm presets, without paragraphWithLevel and every other fix of the shared array. */
  const failing = async (pipeline: Pipeline): Promise<string[]> => {
    const bad: string[] = [];
    for (const entry of entries.filter((item) => item.group !== 'real' && item.group !== 'gfm' && item.group !== 'wiki')) {
      const result = await observe(pipeline, entry.markdown);
      const markdownOut = result.first.markdown;
      const diff = markdownOut === undefined ? undefined : markedDifference(entry.markdown, markdownOut);
      const files = expectedFiles(result, diff);
      const path = (suffix: string): string => join(EXPECTED_DIR, `${entry.group}/${entry.name}.${suffix}`);
      try {
        for (const [suffix, content] of Object.entries(files)) assertMatches(path(suffix), content);
      } catch {
        bad.push(`${entry.group}/${entry.name}`);
      }
    }
    return bad;
  };

  it('the shared plugin array passes the same check', async () => {
    expect(await failing(sharedPipeline)).toEqual([]);
  });

  it('the plain presets make the corpus fail', async () => {
    const plain = pipelineOn(await createHeadless([...commonmark, ...gfm].flat()));
    const bad = await failing(plain);
    expect(bad.length).toBeGreaterThan(20);
    expect(bad).toContain('proof/proof-fix07-mark-adjacency');
  });
});
