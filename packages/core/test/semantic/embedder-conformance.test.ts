import { describe, expect, it } from 'vitest';
import { FakeEmbedder } from '../../src/testing/fake-embedder.js';
import { embedderCaseNames, embedderConformance, type EmbedderHarness } from '../../src/testing/embedder-conformance.js';

const harness: EmbedderHarness = { make: () => Promise.resolve(new FakeEmbedder()), longText: (model) => 'word '.repeat(model.maxTokens + 5) };

describe('FakeEmbedder conformance (the cases the real adapter runs too)', () => {
  it('lists the cases, in order', () => {
    expect(embedderConformance.map((c) => c.name)).toEqual([...embedderCaseNames]);
  });
  for (const c of embedderConformance) it(c.name, () => c.run(harness));
});
